// Corpus ingestion engine. Store-agnostic: it talks to a tiny table interface (`EvidenceDb`) implemented over
// supabase-js (service role, scripts) and over PGlite (tests run it against the REAL migrated schema, so every
// database trigger and constraint participates).
//
// Safety properties (all tested):
//   * idempotent: re-running with an unchanged corpus changes nothing;
//   * content is immutable: changed content becomes a NEW version, never an in-place edit;
//   * fail closed: the effective status is capped by the sanitiser/scanner/trust rules (see trust.ts);
//   * the database is authoritative once an item exists: ingestion may LOWER trust or quarantine an item, but it
//     never raises trust or releases a quarantine unless the curator passes `allowRelease`;
//   * nothing is ever deleted; withdrawn is terminal.
import type { PreparedDocument } from "./prepare";
import { buildManifest, ingestOrder, type CorpusManifest } from "./manifest";

export type Row = Record<string, unknown>;

export interface EvidenceDb {
  select(table: string, match?: Row): Promise<Row[]>;
  insert(table: string, rows: Row[]): Promise<Row[]>;
  update(table: string, match: Row, patch: Row): Promise<number>;
}

export interface IngestOptions {
  dryRun?: boolean;
  /** Mark the resulting corpus snapshot as the active one. */
  activate?: boolean;
  /** Curator override: allow raising trust and releasing quarantined items. */
  allowRelease?: boolean;
  corpusName?: string;
  notes?: string;
  now?: () => string;
}

export interface DocResult {
  canonical_id: string;
  actions: string[];
  status: string | null;
  problems: string[];
}

export interface IngestReport {
  ok: boolean;
  dryRun: boolean;
  corpusHash: string;
  manifest: CorpusManifest;
  documents: DocResult[];
  snapshot: { id: string | null; created: boolean; activated: boolean } | null;
  errors: string[];
}

export const TRANSITIONS: Record<string, string[]> = {
  draft: ["quarantined", "current", "withdrawn"],
  quarantined: ["draft", "current", "withdrawn"],
  current: ["superseded", "withdrawn", "historical", "quarantined"],
  superseded: ["historical", "withdrawn"],
  historical: ["withdrawn"],
  withdrawn: [],
};

/** Shortest legal path of status changes (excluding `from`, including `to`); null when none exists. */
export function statusPath(from: string, to: string): string[] | null {
  if (from === to) return [];
  const prev = new Map<string, string>([[from, ""]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of TRANSITIONS[cur] ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path: string[] = [];
        for (let s = to; s !== from; s = prev.get(s)!) path.unshift(s);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

const TRUST_ORDER = ["unreviewed", "reviewed", "trusted"];
const COMPARED = [
  "title", "publisher", "source_type", "reference_url", "citation", "publication_date", "language", "source_class", "evidence_kind",
  "topics", "syndromes", "geo_scope", "geo_region_id", "valid_from", "valid_until", "review_due", "licence", "source_domain",
  "verification_basis", "supersedes_id",
];

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
  return v === undefined ? null : v;
}
const same = (a: unknown, b: unknown): boolean => norm(a) === norm(b);

export function desiredItem(p: PreparedDocument, regionId: string | null, supersedesId: string | null): Row {
  const d = p.doc;
  return {
    title: p.fields.title, publisher: p.fields.publisher, source_type: d.source_type, reference_url: d.reference_url,
    citation: p.fields.citation, publication_date: d.publication_date, language: d.language, trust_level: p.decision.trustLevel,
    source_class: d.source_class, evidence_kind: d.evidence_kind, topics: [...d.topics].sort(), syndromes: [...d.syndromes].sort(),
    geo_scope: d.geo_scope, geo_region_id: regionId, canonical_id: d.canonical_id, valid_from: d.valid_from, valid_until: d.valid_until,
    review_due: d.review_due, supersedes_id: supersedesId, licence: p.fields.licence, source_domain: d.source_domain,
    verification_basis: [...d.verification_basis].sort(), is_synthetic: d.is_synthetic,
  };
}

async function regionId(db: EvidenceDb, code: string | null, cache: Map<string, string | null>): Promise<string | null> {
  if (!code) return null;
  if (!cache.has(code)) cache.set(code, ((await db.select("regions", { administrative_code: code }))[0]?.id as string | undefined) ?? null);
  return cache.get(code) ?? null;
}

async function applyDocument(
  db: EvidenceDb, p: PreparedDocument, opts: IngestOptions, regions: Map<string, string | null>, ids: Map<string, string>,
): Promise<DocResult> {
  const id = p.doc.canonical_id;
  const res: DocResult = { canonical_id: id, actions: [], status: null, problems: [] };
  const dry = opts.dryRun === true;
  const now = (opts.now ?? (() => new Date().toISOString()))();

  if (p.errors.length) {
    res.problems.push(...p.errors.map((e) => `invalid: ${e}`));
    return res;
  }
  const rId = await regionId(db, p.doc.geo_region_code, regions);
  if (p.doc.geo_region_code && !rId) {
    res.problems.push(`region_not_found:${p.doc.geo_region_code}`);
    return res;
  }
  let supersedesId: string | null = null;
  if (p.doc.supersedes) {
    supersedesId = ids.get(p.doc.supersedes) ?? ((await db.select("evidence_items", { canonical_id: p.doc.supersedes }))[0]?.id as string | undefined) ?? null;
    if (!supersedesId && !dry) {
      res.problems.push(`predecessor_missing:${p.doc.supersedes}`);
      return res;
    }
  }

  const existing = await db.select("evidence_items", { canonical_id: id });
  if (existing.length > 1) {
    res.problems.push("ambiguous: more than one item has this canonical_id");
    return res;
  }
  const want = desiredItem(p, rId, supersedesId);
  const target = p.decision.status;
  let itemId: string | null = null;
  let current: string;
  let pendingPatch: Row = {};

  if (!existing.length) {
    res.actions.push("create");
    if (dry) {
      res.actions.push(...(statusPath("draft", target) ?? []).map((s) => `status:${s}`));
      res.status = target;
      return res;
    }
    const initial = target === "quarantined" ? "quarantined" : "draft";
    const row: Row = { ...want, status: initial, verified_at: want.trust_level === "unreviewed" ? null : now };
    try {
      itemId = (await db.insert("evidence_items", [row]))[0].id as string;
    } catch (e) {
      res.problems.push(`insert_failed:${(e as Error).message}`);
      return res;
    }
    current = initial;
  } else {
    const item = existing[0];
    itemId = item.id as string;
    current = item.status as string;
    if (item.is_synthetic !== p.doc.is_synthetic) {
      res.problems.push("blocked: is_synthetic is immutable");
      return res;
    }
    const patch: Row = {};
    for (const k of COMPARED) {
      if (k === "supersedes_id" && !supersedesId) continue;
      if (!same(item[k], want[k])) patch[k] = want[k];
    }
    // Trust: ingestion may lower it; raising it is a curator decision.
    const have = TRUST_ORDER.indexOf(String(item.trust_level));
    const wantRank = TRUST_ORDER.indexOf(String(want.trust_level));
    if (wantRank < have || (wantRank > have && opts.allowRelease)) {
      patch.trust_level = want.trust_level;
      if (wantRank > have && !item.verified_at) patch.verified_at = now;
    } else if (wantRank > have) res.problems.push(`held: file requests trust ${want.trust_level}, database has ${item.trust_level} (use --release)`);
    if (Object.keys(patch).length) {
      res.actions.push(`metadata:${Object.keys(patch).sort().join(",")}`);
      pendingPatch = patch;
    }
  }

  // ---- versions and chunks ----
  const versions = existing.length ? await db.select("evidence_versions", { evidence_item_id: itemId }) : [];
  const live = versions.find((v) => v.is_current === true);
  const needsVersion = !live || live.content_hash !== p.contentHash;
  if (needsVersion) {
    const sameLabel = versions.find((v) => v.version_label === p.doc.version_label);
    const olderSameContent = versions.find((v) => v.content_hash === p.contentHash);
    if (sameLabel) res.problems.push(`version_label_reused:${p.doc.version_label} (content changed; bump version_label)`);
    else if (olderSameContent) res.problems.push("content_matches_an_older_version (reverting is not supported; publish a new edition)");
    else {
      res.actions.push(live ? "new_version" : "version");
      if (!dry) {
        if (live) await db.update("evidence_versions", { id: live.id }, { is_current: false });
        const v = (await db.insert("evidence_versions", [{
          evidence_item_id: itemId, version_label: p.doc.version_label, content_hash: p.contentHash,
          abstract: p.fields.abstract || null, source_hash: p.doc.source_content_hash, fetch_status: "not_fetched", is_current: true,
        }]))[0];
        await db.insert("evidence_chunks", p.chunks.map((c) => ({
          version_id: v.id, ordinal: c.ordinal, kind: c.kind, text: c.text, chunk_hash: c.chunk_hash, language: p.doc.language,
        })));
        res.actions.push(`chunks:${p.chunks.length}`);
      }
    }
  }
  if (res.problems.length) {
    res.status = current;
    return res;
  }

  // ---- status (and the metadata patch, ordered so the DB "current needs trust/class" constraint always holds) ----
  let desired = target;
  if (existing.length && current === "quarantined" && target !== "quarantined" && target !== "withdrawn" && !opts.allowRelease) {
    res.problems.push("held_in_quarantine: release it as a curator (--release) after review");
    desired = "quarantined";
  }
  // e.g. current -> draft is walked as current -> quarantined -> draft: the document leaves `current` first.
  const path = statusPath(current, desired);
  const applyPatch = async (): Promise<void> => {
    if (dry || !Object.keys(pendingPatch).length) return;
    try {
      await db.update("evidence_items", { id: itemId }, pendingPatch);
    } catch (e) {
      res.problems.push(`metadata_failed:${(e as Error).message}`);
    }
  };
  const applySteps = async (): Promise<void> => {
    for (const step of path ?? []) {
      res.actions.push(`status:${step}`);
      if (dry) continue;
      try {
        await db.update("evidence_items", { id: itemId }, { status: step });
      } catch (e) {
        res.problems.push(`status_failed:${step}:${(e as Error).message}`);
        return;
      }
      current = step;
    }
  };
  if (!path) res.problems.push(`status_transition_not_allowed:${current}->${desired}`);
  // Leaving `current` must happen before trust/class are lowered; reaching it only after they are raised.
  if (current === "current" && desired !== "current") {
    await applySteps();
    await applyPatch();
  } else {
    await applyPatch();
    if (!res.problems.some((p) => p.startsWith("metadata_failed"))) await applySteps();
  }
  res.status = dry ? (path ? (path.length ? path[path.length - 1] : current) : current) : current;
  if (!dry && itemId) ids.set(id, itemId);

  // ---- translations (provenance recorded; never used for ranking in M4) ----
  if (!dry) {
    for (const t of p.fields.translations) {
      const have = (await db.select("evidence_translations", { evidence_item_id: itemId, language: t.language }))[0];
      if (!have) {
        await db.insert("evidence_translations", [{ evidence_item_id: itemId, language: t.language, title: t.title, abstract: t.abstract || null, provenance: t.provenance }]);
        res.actions.push(`translation:${t.language}`);
      } else if (have.review_status === "draft" && (have.title !== t.title || (have.abstract ?? "") !== t.abstract || have.provenance !== t.provenance)) {
        await db.update("evidence_translations", { id: have.id }, { title: t.title, abstract: t.abstract || null, provenance: t.provenance });
        res.actions.push(`translation_updated:${t.language}`);
      }
    }
  }
  return res;
}

export async function ingestCorpus(db: EvidenceDb, prepared: PreparedDocument[], opts: IngestOptions = {}): Promise<IngestReport> {
  const manifest = buildManifest(opts.corpusName ?? "corpus", prepared);
  const report: IngestReport = { ok: false, dryRun: opts.dryRun === true, corpusHash: manifest.corpus_hash, manifest, documents: [], snapshot: null, errors: [] };
  const regions = new Map<string, string | null>();
  const ids = new Map<string, string>();
  for (const p of ingestOrder(prepared)) {
    try {
      report.documents.push(await applyDocument(db, p, opts, regions, ids));
    } catch (e) {
      report.documents.push({ canonical_id: p.doc.canonical_id, actions: [], status: null, problems: [`exception:${(e as Error).message}`] });
    }
  }
  const failed = report.documents.filter((d) => d.problems.length);
  for (const d of failed) report.errors.push(`${d.canonical_id}: ${d.problems.join("; ")}`);
  report.ok = failed.length === 0;
  if (!report.ok || report.dryRun) return report;

  // The snapshot is recorded only when the database matches the manifest exactly.
  const existing = (await db.select("corpus_snapshots", { corpus_hash: manifest.corpus_hash }))[0];
  let snapshotId = existing?.id as string | undefined;
  const created = !existing;
  if (!existing) {
    const name = opts.corpusName ?? "corpus";
    snapshotId = (await db.insert("corpus_snapshots", [{
      corpus_version: `${name}+${manifest.corpus_hash.slice(0, 12)}`, corpus_hash: manifest.corpus_hash,
      item_count: manifest.counts.documents, chunk_count: manifest.counts.chunks, includes_synthetic: manifest.counts.synthetic > 0,
      notes: opts.notes ?? null, is_active: false,
    }]))[0].id as string;
  }
  let activated = false;
  if (opts.activate && snapshotId) {
    await db.update("corpus_snapshots", { is_active: true }, { is_active: false });
    await db.update("corpus_snapshots", { id: snapshotId }, { is_active: true });
    activated = true;
  }
  report.snapshot = { id: snapshotId ?? null, created, activated };
  return report;
}

/** Compare the database with what the corpus says it should contain. Returns mismatches (empty = identical). */
export async function verifyIngested(db: EvidenceDb, prepared: PreparedDocument[]): Promise<string[]> {
  const problems: string[] = [];
  const regions = new Map<string, string | null>();
  for (const p of prepared) {
    const cid = p.doc.canonical_id;
    const item = (await db.select("evidence_items", { canonical_id: cid }))[0];
    if (!item) {
      problems.push(`${cid}: missing`);
      continue;
    }
    if (item.status !== p.decision.status) problems.push(`${cid}: status ${String(item.status)} != ${p.decision.status}`);
    if (item.trust_level !== p.decision.trustLevel) problems.push(`${cid}: trust_level ${String(item.trust_level)} != ${p.decision.trustLevel}`);
    const want = desiredItem(p, await regionId(db, p.doc.geo_region_code, regions), null);
    for (const k of COMPARED) if (k !== "supersedes_id" && !same(item[k], want[k])) problems.push(`${cid}: ${k} differs`);
    const live = (await db.select("evidence_versions", { evidence_item_id: item.id, is_current: true }))[0];
    if (!live) problems.push(`${cid}: no current version`);
    else {
      if (live.content_hash !== p.contentHash) problems.push(`${cid}: content_hash differs`);
      const chunks = (await db.select("evidence_chunks", { version_id: live.id })).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      if (JSON.stringify(chunks.map((c) => c.chunk_hash)) !== JSON.stringify(p.chunks.map((c) => c.chunk_hash))) problems.push(`${cid}: chunks differ`);
    }
  }
  return problems;
}
