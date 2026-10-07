// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADVERSARIAL_IDS, buildDevCorpus, renderDoc, type DocInput } from "../devcorpus/specs";
import { canonicalJson, hashJson, sha256Hex } from "../hash";
import { parseCorpusDocument } from "./document";
import { buildCorpus, loadCorpusDir } from "./loader";
import { buildManifest, ingestOrder, validateCorpus } from "./manifest";
import { prepareDocument, type PreparedDocument } from "./prepare";
import { EMPTY_ALLOWLIST } from "./trust";

const ROOT = process.cwd();
const CORPUS_DIR = join(ROOT, "data", "evidence", "corpus");
const ALLOWLIST = join(ROOT, "data", "evidence", "allowlist.json");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * Pinned on purpose. Any change to a corpus document, the generator, the sanitiser, the scanner or the trust rules
 * changes this hash; updating the pin is a deliberate, reviewed act (like the frozen M3 config hash).
 */
const GOLDEN_CORPUS_HASH = "a66e0364a6b0c216381cfa9a6f0db846aa672f4b918587592cbcfe2ddfd497d2";

const prep = (inputs: DocInput[]): PreparedDocument[] =>
  inputs.map((d) => {
    const r = parseCorpusDocument(d);
    if (!r.doc) throw new Error(`${d.canonical_id}: ${r.errors.join("; ")}`);
    return prepareDocument(r.doc, EMPTY_ALLOWLIST);
  });
const shuffle = <T>(xs: T[], seed: number): T[] => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

describe("canonical hashing", () => {
  it("is independent of key order and sensitive to values and array order", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe(canonicalJson({ a: [2, 1], b: 1 }));
    expect(hashJson({ a: [1, 2] })).not.toBe(hashJson({ a: [2, 1] }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: "1" }));
  });
  it("refuses values with no canonical form", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/unsupported/);
  });
  it("matches a known SHA-256 vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("manifest", () => {
  const docs = buildDevCorpus();
  const base = buildManifest("t", prep(docs));

  it("is identical regardless of document order", () => {
    for (const seed of [1, 2, 3]) expect(buildManifest("t", prep(shuffle(docs, seed))).corpus_hash).toBe(base.corpus_hash);
  });

  it("changes when one character of one chunk changes", () => {
    const edited = docs.map((d) => (d.canonical_id === "syn-ads-case-definition" ? { ...d, abstract: `${d.abstract as string}.` } : d));
    expect(buildManifest("t", prep(edited)).corpus_hash).not.toBe(base.corpus_hash);
  });

  it("changes when only metadata changes", () => {
    const edited = docs.map((d) => (d.canonical_id === "syn-ads-case-definition" ? { ...d, topics: ["case_definition"] } : d));
    expect(buildManifest("t", prep(edited)).corpus_hash).not.toBe(base.corpus_hash);
  });

  it("changes when a document's effective status changes", () => {
    const edited = docs.map((d) => (d.canonical_id === "syn-ads-case-definition" ? { ...d, declared_status: "withdrawn" } : d));
    expect(buildManifest("t", prep(edited)).corpus_hash).not.toBe(base.corpus_hash);
  });

  it("records rule versions, sorted entries and consistent counts", () => {
    expect(base.entries.map((e) => e.canonical_id)).toEqual([...base.entries.map((e) => e.canonical_id)].sort());
    expect(base.counts.documents).toBe(base.entries.length);
    expect(Object.values(base.counts.by_status).reduce((a, b) => a + b, 0)).toBe(base.entries.length);
    expect(base.counts.chunks).toBe(base.entries.reduce((n, e) => n + e.chunk_hashes.length, 0));
    expect(base.sanitiser_version).toMatch(/^sanitise\//);
    expect(base.scanner_version).toMatch(/^inject-scan\//);
    expect(base.trust_rules_version).toMatch(/^trust-rules\//);
  });

  it("contains no personal or free-text content beyond hashes and codes", () => {
    const text = JSON.stringify(base);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/Ignore all previous/i);
  });
});

describe("corpus validation", () => {
  const ok = prep(buildDevCorpus());
  it("accepts the development corpus (duplicate content is only a warning)", () => {
    const v = validateCorpus(ok);
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.includes("syn-ads-verification-exact-copy"))).toBe(true);
  });

  it("rejects duplicate ids, duplicate URLs and unknown or cyclic supersession", () => {
    const [a, b] = buildDevCorpus().filter((d) => d.canonical_id.startsWith("syn-ads-"));
    expect(validateCorpus(prep([a, a])).errors.join()).toMatch(/duplicate canonical_id/);
    expect(validateCorpus(prep([a, { ...b, reference_url: a.reference_url }])).errors.join()).toMatch(/reference_url already used/);
    expect(validateCorpus(prep([{ ...a, supersedes: "does-not-exist" }])).errors.join()).toMatch(/unknown document/);
    const x = { ...a, canonical_id: "syn-cycle-x", reference_url: "https://corpus.synthetic-health.invalid/x", supersedes: "syn-cycle-y", declared_status: "superseded" };
    const y = { ...a, canonical_id: "syn-cycle-y", reference_url: "https://corpus.synthetic-health.invalid/y", supersedes: "syn-cycle-x", declared_status: "superseded" };
    expect(validateCorpus(prep([x, y])).errors.join()).toMatch(/cycle/);
  });

  it("requires the superseded document to be declared superseded and chains to be linear", () => {
    const [a] = buildDevCorpus();
    const old = { ...a, canonical_id: "syn-old-doc", reference_url: "https://corpus.synthetic-health.invalid/o" };
    const n1 = { ...a, canonical_id: "syn-new-one", reference_url: "https://corpus.synthetic-health.invalid/n1", supersedes: "syn-old-doc" };
    expect(validateCorpus(prep([old, n1])).errors.join()).toMatch(/must be declared superseded/);
    const oldS = { ...old, declared_status: "superseded" };
    const n2 = { ...a, canonical_id: "syn-new-two", reference_url: "https://corpus.synthetic-health.invalid/n2", supersedes: "syn-old-doc" };
    expect(validateCorpus(prep([oldS, n1, n2])).errors.join()).toMatch(/already superseded by/);
  });

  it("surfaces per-document post-sanitise errors", () => {
    const [a] = buildDevCorpus();
    const huge = { ...a, excerpts: [{ text: "word ".repeat(400) }] };
    expect(validateCorpus(prep([huge])).errors.join()).toMatch(/shorten/);
  });

  it("orders predecessors before successors", () => {
    const order = ingestOrder(ok).map((p) => p.doc.canonical_id);
    expect(order.indexOf("syn-ads-verification-guidance-2022")).toBeLessThan(order.indexOf("syn-ads-verification-guidance-2025"));
  });
});

describe("the committed development corpus", () => {
  const built = buildCorpus(CORPUS_DIR, ALLOWLIST, "jansanket-dev-corpus");

  it("loads without any problem", () => {
    expect(built.fileErrors).toEqual([]);
    expect(built.validation.errors).toEqual([]);
  });

  it("matches its pinned golden corpus hash", () => {
    expect(built.manifest.corpus_hash).toBe(GOLDEN_CORPUS_HASH);
  });

  it("is reproducible: same files give the same hash however they are ordered or reloaded", () => {
    expect(buildCorpus(CORPUS_DIR, ALLOWLIST, "jansanket-dev-corpus").manifest.corpus_hash).toBe(GOLDEN_CORPUS_HASH);
    const { docs } = loadCorpusDir(CORPUS_DIR);
    const again = buildManifest("jansanket-dev-corpus", shuffle(docs, 7).map((d) => prepareDocument(d, EMPTY_ALLOWLIST)));
    expect(again.corpus_hash).toBe(GOLDEN_CORPUS_HASH);
  });

  it("equals the generator output byte for byte (line endings aside)", () => {
    const spec = buildDevCorpus();
    const files = readdirSync(join(CORPUS_DIR, "docs")).sort();
    expect(files).toEqual(spec.map((d) => `${d.canonical_id}.json`).sort());
    for (const d of spec) expect(lf(readFileSync(join(CORPUS_DIR, "docs", `${d.canonical_id}.json`), "utf8")), d.canonical_id).toBe(renderDoc(d));
  });

  it("has a committed manifest identical to the regenerated one", () => {
    expect(lf(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8"))).toBe(JSON.stringify(built.manifest, null, 2) + "\n");
  });

  it("is entirely synthetic: no real publisher, URL, DOI or licence", () => {
    for (const p of built.prepared) {
      expect(p.doc.is_synthetic, p.doc.canonical_id).toBe(true);
      expect(p.doc.publisher).toMatch(/Synthetic/);
      expect(p.doc.citation ?? "").toMatch(/^SYNTHETIC/);
      expect(p.doc.licence ?? "").toMatch(/SYNTHETIC/);
    }
    const hosts = new Set<string>();
    for (const f of readdirSync(join(CORPUS_DIR, "docs"))) {
      for (const m of readFileSync(join(CORPUS_DIR, "docs", f), "utf8").matchAll(/https?:\/\/([^/"\s?#:]+)/gi)) hosts.add(m[1].toLowerCase());
      expect(readFileSync(join(CORPUS_DIR, "docs", f), "utf8"), f).not.toMatch(/\bdoi\.org|\b10\.\d{4,9}\/\S+/i);
    }
    expect([...hosts].filter((h) => !h.endsWith(".invalid"))).toEqual([]);
  });

  it("covers every issuer class, evidence kind, geography level, language and lifecycle status", () => {
    const e = built.manifest.entries;
    const has = (key: keyof (typeof e)[number], values: string[]) => for_all(values, (v) => e.some((x) => x[key] === v));
    expect(has("source_class", ["intergovernmental_health_authority", "national_government_health_agency", "state_government_health_agency", "peer_reviewed_literature", "recognized_institution", "professional_society_guideline", "other_verified", "unverified"])).toBe(true);
    expect(has("evidence_kind", ["operational_guidance", "case_definition", "clinical_epidemiology_reference", "situation_report", "surveillance_data", "research"])).toBe(true);
    expect(has("geo_scope", ["global", "regional", "national", "state", "district"])).toBe(true);
    expect(has("language", ["en", "hi", "or"])).toBe(true);
    expect(has("status", ["current", "superseded", "withdrawn", "historical", "draft", "quarantined"])).toBe(true);
  });

  it("quarantines every adversarial fixture even though each is declared current and trusted", () => {
    for (const id of ADVERSARIAL_IDS) {
      const p = built.prepared.find((x) => x.doc.canonical_id === id)!;
      expect(p.doc.declared_status, id).toBe("current");
      expect(p.decision.status, id).toBe("quarantined");
    }
  });

  it("raises no scanner finding on any non-adversarial document", () => {
    for (const p of built.prepared.filter((x) => !(ADVERSARIAL_IDS as readonly string[]).includes(x.doc.canonical_id))) {
      expect(p.scan.findings, p.doc.canonical_id).toEqual([]);
    }
  });

  it("stores only sanitised plain text", () => {
    for (const p of built.prepared) for (const c of p.chunks) expect(c.text, p.doc.canonical_id).not.toMatch(/<\s*\/?\s*[a-zA-Z!][^>]*>/);
  });
});

function for_all(values: string[], pred: (v: string) => boolean): boolean {
  return values.every(pred);
}
