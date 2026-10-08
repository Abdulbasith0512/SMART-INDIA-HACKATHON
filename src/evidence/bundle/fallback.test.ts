// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../hash";
import { makeRankingConfig } from "../ranking/policy";
import type { CorpusView } from "../retrieval/corpus";
import { makeFacts, uid, viewFromPrepared, withTags } from "../retrieval/testkit";
import { FALLBACK_OPENING, FALLBACK_VERSION, FORBIDDEN_FALLBACK_WORDING, ownWording, renderExtractive, validateFallback, type CitationMetadata } from "./fallback";
import { devMetadata, devResolver, referenceBundle } from "./testkit";

const GOLDEN_FALLBACK_SHA = "0f3ebd8d5c375d4b90ebe9cdd5d2c371086b5118a684299b7dcd81fc1ae659af";
const view = viewFromPrepared();
const bundle = referenceBundle();
const rendered = renderExtractive(bundle, devResolver());
const { fallback } = rendered;
const PAIR = ["syn-conflict-reporting-deadline-a", "syn-conflict-reporting-deadline-b"];

const variants = () => {
  const slim: CorpusView = { ...view, items: view.items.filter((i) => PAIR.includes(i.canonicalId!)) };
  const tags = { "syn-conflict-reporting-deadline-a": { questionKey: "reporting_deadline", position: "within_24_hours" }, "syn-conflict-reporting-deadline-b": { questionKey: "reporting_deadline", position: "within_72_hours" } };
  return {
    reference: bundle,
    empty: referenceBundle({ view: { items: [], activeSnapshot: null }, historicalView: null }),
    thin: referenceBundle({ view: { ...view, items: view.items.filter((i) => i.canonicalId === "syn-ads-case-definition") }, historicalView: null }),
    historical: referenceBundle({ ranking: makeRankingConfig({ topK: 40 }) }),
    conflict: referenceBundle({ view: withTags(slim, tags), historicalView: null, ranking: makeRankingConfig({ relevanceFloor: 0 }) }),
    contradiction: referenceBundle({ view: withTags(view, { "syn-ads-case-definition": { questionKey: "alternative_explanation", position: "contradicts_signal_interpretation" } }), historicalView: null }),
  };
};

describe("required opening", () => {
  it("starts with the exact sentence, ending in a single ellipsis character (U+2026)", () => {
    expect(FALLBACK_OPENING).toBe("Evidence relevant to this emerging signal suggests…");
    expect(FALLBACK_OPENING.codePointAt(FALLBACK_OPENING.length - 1)).toBe(0x2026);
    expect(FALLBACK_OPENING.includes("...")).toBe(false);
    for (const [name, b] of Object.entries(variants())) expect(renderExtractive(b, devResolver()).fallback.text.startsWith(`${FALLBACK_OPENING}\n`), name).toBe(true);
  });
});

describe("determinism", () => {
  it("renders byte-identical text on every run, pinned by hash", () => {
    expect(sha256Hex(fallback.text)).toBe(GOLDEN_FALLBACK_SHA);
    for (let i = 0; i < 20; i += 1) expect(renderExtractive(referenceBundle(), devResolver()).fallback).toEqual(fallback);
  });

  it("is bound to the bundle it came from and has a stable shape", () => {
    expect(fallback).toMatchObject({ schema: "extractive-fallback/1", version: FALLBACK_VERSION, status: "fallback_extractive", bundle_hash: bundle.bundle_hash, opening: FALLBACK_OPENING });
    expect(Object.keys(fallback).sort()).toEqual(["bundle_hash", "gaps", "metadata_hash", "opening", "points", "schema", "status", "text", "thin", "version"]);
  });
});

describe("it quotes the bundle and only the bundle", () => {
  it("has one point per selected item, in facet and rank order, each the stored excerpt verbatim", () => {
    const expected = [...bundle.facets.flatMap((f) => f.items.map((i) => ({ facet: f.name, i }))), ...bundle.historical_context.map((i) => ({ facet: "historical_context", i }))];
    expect(fallback.points.map((p) => [p.facet, p.citation_id])).toEqual(expected.map((e) => [e.facet, e.i.citation_id]));
    for (const [k, p] of fallback.points.entries()) {
      expect(p.claim_index).toBe(k);
      expect(p.excerpt).toBe(expected[k].i.excerpt);
      expect(fallback.text).toContain(`[${p.citation_id}] "${p.excerpt}"`);
    }
  });

  it("introduces no passage that is not a bundle excerpt", () => {
    const excerpts = new Set([...bundle.facets.flatMap((f) => f.items.map((i) => i.excerpt)), ...bundle.historical_context.map((i) => i.excerpt)]);
    const quoted = rendered.parts.filter((p) => p.kind === "excerpt");
    expect(quoted.length).toBe(fallback.points.length);
    for (const q of quoted) expect(excerpts.has(q.text)).toBe(true);
  });

  it("cites only ids that exist in the bundle, and fabricates none", () => {
    const ids = new Set(bundle.citations.map((c) => c.citation_id));
    for (const m of fallback.text.matchAll(/\[(E\d+)\]/g)) expect(ids.has(m[1])).toBe(true);
    expect(fallback.text).not.toMatch(/\[E0\]|\[E999\]/);
  });

  it("restates the bundle's gaps exactly", () => {
    expect(fallback.gaps).toEqual(bundle.gaps.map((g) => g.message));
    for (const g of bundle.gaps) expect(fallback.text).toContain(`- ${g.message}\n`);
  });

  it("uses a fixed set of template sentences (a pinned whitelist)", () => {
    const norm = (s: string) => s.replace(/\[E\d+\]/g, "[E#]").replace(/\d{4}-\d{2}-\d{2}/g, "DATE").replace(/\d+/g, "#");
    const templates = [...new Set(rendered.parts.filter((p) => p.kind === "template").map((p) => norm(p.text)))].sort();
    // The source line states the tier and scope recorded for the document, so its label varies with the evidence.
    const sourceLine = /^\. [A-Z][A-Za-z -]+; (global|national|state|district|regional) scope; $/;
    expect(templates.filter((t) => sourceLine.test(t)).length).toBeGreaterThan(0);
    expect(templates.filter((t) => !sourceLine.test(t))).toEqual([
      "\n",
      "\nCase definition\n",
      "\nEpidemiological context\n",
      "\nGaps in the evidence\n",
      "\nRegional context\n",
      "\nThis text only repeats retrieved passages and the details of their sources. It is an emerging signal requiring verification by a public-health officer and is not a finding.\n",
      "\nVerification guidance\n",
      '\n[E#] "',
      '"\n    ',
      ", DATE to DATE. This is an emerging signal requiring verification.\n",
      "- ",
      ".",
      "; ",
      "; SYNTHETIC TEST DOCUMENT, not real evidence",
      "Evidence relevant to this emerging signal suggests…\n\n",
      "Signal: acute diarrhoeal illness reports in ",
      "Source: ",
      "The passages below are quoted exactly as stored; nothing has been added to them.\n",
    ]);
  });
});

describe("source metadata comes from the database through the stored ids", () => {
  it("renders title, publisher, URL, date and licence status from the resolver, not from the bundle", () => {
    const first = bundle.facets[0].items[0];
    const m = devMetadata().get(first.evidence_version_id)!;
    expect(fallback.text).toContain(`Source: ${m.title} - ${m.publisher}.`);
    expect(fallback.text).toContain(`published ${m.publication_date}`);
    expect(fallback.text).toContain(m.reference_url!);
    expect(JSON.stringify(bundle)).not.toContain(m.title);
  });

  it("follows the database: different stored metadata gives different rendered metadata", () => {
    const base = devMetadata();
    const edited = (id: string): CitationMetadata | undefined => {
      const m = base.get(id);
      return m ? { ...m, title: `EDITED ${m.title}`, publisher: "Edited Publisher" } : undefined;
    };
    const other = renderExtractive(bundle, edited).fallback;
    expect(other.text).toContain("EDITED Synthetic procedure for verifying");
    expect(other.text).not.toBe(fallback.text);
    expect(other.metadata_hash).not.toBe(fallback.metadata_hash);
    expect(other.points).toEqual(fallback.points); // the quoted evidence is unchanged
  });

  it("refuses to render a citation it cannot resolve in the database (it never invents metadata)", () => {
    expect(() => renderExtractive(bundle, () => undefined)).toThrow(/no database metadata for evidence version/);
    const partial = devMetadata();
    partial.delete(bundle.facets[0].items[0].evidence_version_id);
    expect(() => renderExtractive(bundle, (id) => partial.get(id))).toThrow(/E1/);
  });

  it("marks synthetic sources as test documents and says nothing of the kind for real ones", () => {
    expect(fallback.text).toContain("SYNTHETIC TEST DOCUMENT, not real evidence");
    const real = (id: string) => {
      const m = devMetadata().get(id);
      return m ? { ...m, is_synthetic: false } : undefined;
    };
    expect(renderExtractive(bundle, real).fallback.text).not.toContain("not real evidence");
  });

  it("says when a publication date is not recorded", () => {
    const undated = (id: string) => {
      const m = devMetadata().get(id);
      return m ? { ...m, publication_date: null } : undefined;
    };
    expect(renderExtractive(bundle, undated).fallback.text).toContain("publication date not recorded");
  });

  it("uses the citation text when there is no URL", () => {
    const noUrl = (id: string) => {
      const m = devMetadata().get(id);
      return m ? { ...m, reference_url: null, citation: "Citation Text 42" } : undefined;
    };
    expect(renderExtractive(bundle, noUrl).fallback.text).toContain("Citation Text 42");
  });
});

describe("the fallback never diagnoses, names a cause, claims an outbreak or advises treatment", () => {
  it("has no such wording in anything it authors, in any variant", () => {
    for (const [name, b] of Object.entries(variants())) {
      const r = renderExtractive(b, devResolver());
      for (const own of ownWording(b, r.parts)) expect(own, `${name}: ${own}`).not.toMatch(FORBIDDEN_FALLBACK_WORDING);
      expect(validateFallback(b, r).every((c) => c.ok), name).toBe(true);
    }
  });

  it("the guard really does detect such wording", () => {
    for (const bad of ["an outbreak is confirmed", "a diagnosis of cholera", "caused by contaminated water", "recommended treatment", "confirmed cases", "patients should", "an epidemic", "give the dose", "vaccination", "due to"]) {
      expect(FORBIDDEN_FALLBACK_WORDING.test(bad), bad).toBe(true);
    }
    expect(FORBIDDEN_FALLBACK_WORDING.test("This is an emerging signal requiring verification by a public-health officer.")).toBe(false);
  });

  it("detects each flagged stem on its own", () => {
    for (const w of ["outbreak", "epidemic", "pandemic", "diagnosis", "confirmed", "treatment", "therapy", "medication", "prescribed", "a dose", "a cure", "vaccination", "caused by", "due to", "infection", "patient", "patients"]) expect(FORBIDDEN_FALLBACK_WORDING.test(w), w).toBe(true);
  });

  it("is not fooled by a place or document name that contains a flagged word", () => {
    const b = referenceBundle({ facts: makeFacts({ region: { id: uid("r"), name: "Outbreak Road", level: "block" }, ancestors: [{ id: uid("d"), name: "Treatment District", level: "district" }, { id: uid("s"), name: "Diagnosis State", level: "state" }, { id: uid("c"), name: "India", level: "country" }] }) });
    const r = renderExtractive(b, devResolver());
    expect(r.fallback.text).toContain("Outbreak Road");
    expect(validateFallback(b, r).find((c) => c.name.includes("own wording"))!.ok).toBe(true);
  });

  it("is not fooled by a curated document id inside a gap message", () => {
    const b = variants().contradiction;
    expect(b.gaps.some((g) => g.code === "contradicting_evidence")).toBe(true);
    expect(validateFallback(b, renderExtractive(b, devResolver())).every((c) => c.ok)).toBe(true);
  });

  it("can quote evidence that itself contains such words, because quotes are labelled data, not the fallback's own claim", () => {
    const stuffed = fallback.text.includes("diarrhoeal disease outbreak diarrhoea cluster");
    expect(stuffed).toBe(true);
    expect(validateFallback(bundle, rendered).every((c) => c.ok)).toBe(true);
  });
});

describe("empty and thin evidence are stated, never filled", () => {
  it("an empty result says there is nothing to quote, lists the gaps, and quotes nothing", () => {
    const b = variants().empty;
    const { fallback: f } = renderExtractive(b, devResolver());
    expect(f.thin).toBe(true);
    expect(f.points).toEqual([]);
    expect(f.text).toContain("No eligible evidence was selected for this signal, so there is nothing to quote.");
    expect(f.text.match(/No eligible evidence was found for this facet\./g)).toHaveLength(4);
    expect(f.text).not.toMatch(/\[E\d+\]/);
    expect(f.text).not.toContain('"');
    expect(f.gaps[0]).toBe("no eligible evidence was found for this signal");
    expect(f.text).toContain("- no eligible evidence was found for this signal");
  });

  it("a thin result says it is incomplete and how little there is", () => {
    const b = variants().thin;
    const { fallback: f } = renderExtractive(b, devResolver());
    expect(f.thin).toBe(true);
    expect(f.text).toMatch(/Limited evidence: only \d+ passage\(s\) from 1 document\(s\) were selected, so this summary is incomplete\./);
    expect(f.points.length).toBeGreaterThan(0);
  });

  it("a well-covered result is not labelled thin", () => {
    expect(fallback.thin).toBe(false);
    expect(fallback.text).not.toContain("Limited evidence");
  });
});

describe("conflicts and historical context", () => {
  it("reports curator-tagged conflicts as such, citing the passages, without inferring any", () => {
    const { fallback: f } = renderExtractive(variants().conflict, devResolver());
    expect(f.text).toContain("Conflicting positions (reported only where curators tagged documents to the same question)");
    expect(f.text).toMatch(/Question "reporting_deadline": position "within_24_hours" \(E\d+(, E\d+)*\); position "within_72_hours" \(E\d+(, E\d+)*\)\./);
    expect(renderExtractive(bundle, devResolver()).fallback.text).not.toContain("Conflicting positions");
  });

  it("shows superseded editions only in the labelled historical section, with the successor", () => {
    const { fallback: f } = renderExtractive(variants().historical, devResolver());
    expect(f.text).toContain("Historical context (superseded or historical documents, shown for context only and not current evidence)");
    expect(f.text).toContain("Superseded by: syn-ads-verification-guidance-2025.");
    const main = f.text.slice(0, f.text.indexOf("Historical context"));
    expect(main).not.toContain("2022 edition");
    expect(fallback.text).not.toContain("Historical context");
  });
});

describe("validation catches a broken fallback", () => {
  const ok = (r: ReturnType<typeof renderExtractive>, b = bundle) => validateFallback(b, r);

  it("passes for the reference fallback", () => {
    expect(ok(rendered).every((c) => c.ok)).toBe(true);
    expect(ok(rendered).map((c) => c.name)).toHaveLength(9);
  });

  it("fails if an excerpt is altered", () => {
    const bad = structuredClone(rendered);
    bad.fallback.points[0].excerpt += " (edited)";
    expect(ok(bad).find((c) => c.name.includes("verbatim"))!.ok).toBe(false);
  });

  it("fails if a quoted part is not a stored excerpt", () => {
    const bad = structuredClone(rendered);
    bad.parts.find((p) => p.kind === "excerpt")!.text = "invented passage";
    expect(ok(bad).find((c) => c.name.includes("quoted stored excerpt"))!.ok).toBe(false);
  });

  it("fails if the text cites an id outside the bundle", () => {
    const bad = structuredClone(rendered);
    bad.fallback.text += "\n[E999] something";
    expect(ok(bad).find((c) => c.name.includes("no citation id outside"))!.ok).toBe(false);
  });

  it("fails if the fallback's own wording turns diagnostic", () => {
    const bad = structuredClone(rendered);
    bad.parts.push({ kind: "template", text: "This confirms the outbreak." });
    expect(ok(bad).find((c) => c.name.includes("own wording"))!.ok).toBe(false);
  });

  it("fails if a gap message carries diagnostic wording (gaps count as the fallback's own wording)", () => {
    const b = structuredClone(bundle);
    b.gaps[0].message = "an outbreak is confirmed in this area";
    expect(ok(renderExtractive(b, devResolver()), b).find((c) => c.name.includes("own wording"))!.ok).toBe(false);
  });

  it("fails if the opening is wrong, the gaps differ, or it belongs to another bundle", () => {
    const wrongOpening = structuredClone(rendered);
    wrongOpening.fallback.text = wrongOpening.fallback.text.replace(FALLBACK_OPENING, "Evidence suggests");
    expect(ok(wrongOpening).find((c) => c.name.includes("opens with"))!.ok).toBe(false);
    const gaps = structuredClone(rendered);
    gaps.fallback.gaps = ["something else"];
    expect(ok(gaps).find((c) => c.name.includes("gaps"))!.ok).toBe(false);
    const other = structuredClone(rendered);
    other.fallback.bundle_hash = "f".repeat(64);
    expect(ok(other).find((c) => c.name.includes("bound to this bundle"))!.ok).toBe(false);
  });

  it("fails if a thin result does not say so", () => {
    const b = variants().thin;
    const r = renderExtractive(b, devResolver());
    r.fallback.text = r.fallback.text.replace(/Limited evidence[^\n]*\n/, "");
    expect(ok(r, b).find((c) => c.name.includes("says so"))!.ok).toBe(false);
  });
});
