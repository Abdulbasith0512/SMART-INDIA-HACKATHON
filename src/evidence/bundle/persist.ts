// Persistence of evidence bundles (service role only).
//
//   retrieval_runs            one provenance row per CREATED bundle (the queries and configuration that produced it)
//   evidence_bundles          the canonical bundle JSON, append-only, unique per (signal, bundle_hash)
//   evidence_bundle_items     one row per citation id: the exact (evidence_version_id, chunk_id) it stands for
//   generated_explanations    the deterministic extractive fallback (status fallback_extractive), idempotent
//   explanation_citations     the fallback's points, each bound to a bundle item
//   signal_evidence           a COMPACT convenience mirror of the most recently persisted bundle's cited documents - never the truth
//
// Idempotent and convergent: persisting the same bundle again creates nothing new and only repairs what is missing,
// so an interrupted write (the REST API has no transaction) is completed by simply running the same persist again.
// The canonical truth is evidence_bundles + evidence_bundle_items; signal_evidence can be rebuilt from them at any time.
import { hashJson } from "../hash";
import { asJson, type EvidenceDb, type Row } from "../ingest/ingest";
import { compareCodePoints } from "../retrieval/tokenize";
import { bundleHashOf } from "./canonical";
import { FALLBACK_VERSION, renderExtractive, validateFallback, type CitationMetadata, type MetadataResolver, type RenderedFallback } from "./fallback";
import type { SignalIdentity } from "./build";
import type { BundleCitation, BundleItem, EvidenceBundle } from "./types";

export const FALLBACK_PROVIDER = "extractive";
export const FALLBACK_MODEL = "deterministic-fallback";
const NOTE_MAX = 480;
const QUOTE_MAX = 600;

const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const dbId = (r: Row): string => r.id as string;

// ---------------------------------------------------------------- reading what a bundle needs from the database
/** The detector's episode key and version for a stored signal. Reads three columns; the counts inside `evidence` are discarded. */
export async function loadSignalIdentity(db: EvidenceDb, signalId: string): Promise<SignalIdentity> {
  const row = (await db.select("signal_candidates", { id: signalId }, ["id", "episode_key", "evidence"]))[0];
  const ev = (row?.evidence && typeof row.evidence === "object" ? row.evidence : {}) as Record<string, unknown>;
  return { episodeKey: (row?.episode_key as string | null) ?? null, detectorVersion: typeof ev.detector_version === "string" ? ev.detector_version : null };
}

/** Source metadata for rendering, resolved from the database by evidence_version_id (never from the bundle or a model). */
export async function loadCitationMetadata(db: EvidenceDb, versionIds: readonly string[]): Promise<Map<string, CitationMetadata>> {
  const out = new Map<string, CitationMetadata>();
  const ids = [...new Set(versionIds)];
  if (!ids.length) return out;
  const versions = await db.select("evidence_versions", { id: ids }, ["id", "evidence_item_id"]);
  const itemIds = [...new Set(versions.map((v) => v.evidence_item_id as string))];
  const items = new Map((await db.select("evidence_items", { id: itemIds }, ["id", "title", "publisher", "source_type", "reference_url", "citation", "publication_date", "licence", "is_synthetic"])).map((i) => [dbId(i), i]));
  for (const v of versions) {
    const i = items.get(v.evidence_item_id as string);
    if (!i) continue;
    out.set(dbId(v), {
      evidence_version_id: dbId(v), title: String(i.title), publisher: String(i.publisher), source_type: String(i.source_type), reference_url: (i.reference_url as string | null) ?? null,
      citation: (i.citation as string | null) ?? null, publication_date: day(i.publication_date), licence: (i.licence as string | null) ?? null, is_synthetic: i.is_synthetic === true,
    });
  }
  return out;
}

export const bundleVersionIds = (b: EvidenceBundle): string[] => b.citations.map((c) => c.evidence_version_id);

// ---------------------------------------------------------------- the bundle's items, as stored rows
interface PlannedItem {
  citation: BundleCitation;
  item: BundleItem;
  facet: string;
  rank: number;
}

/** One planned row per citation: its primary appearance (first facet in facet order; historical context has its own pseudo-facet). */
export function plannedItems(b: EvidenceBundle): PlannedItem[] {
  const byCitation = new Map<string, PlannedItem>();
  for (const f of b.facets) for (const it of f.items) if (!byCitation.has(it.citation_id)) byCitation.set(it.citation_id, { citation: b.citations.find((c) => c.citation_id === it.citation_id)!, item: it, facet: f.name, rank: it.rank });
  for (const h of b.historical_context) byCitation.set(h.citation_id, { citation: b.citations.find((c) => c.citation_id === h.citation_id)!, item: h, facet: "historical_context", rank: h.rank });
  return [...byCitation.values()].sort((a, b) => Number(a.citation.citation_id.slice(1)) - Number(b.citation.citation_id.slice(1)));
}

const itemRow = (bundleId: string, p: PlannedItem): Row => ({
  bundle_id: bundleId,
  evidence_version_id: p.item.evidence_version_id,
  chunk_id: p.item.chunk_id,
  facet: p.facet,
  rank: p.rank,
  citation_id: p.item.citation_id,
  score_components: asJson({ ...p.item.score_components, appears_in: p.citation.appears_in, section: p.citation.section }),
  why: asJson(p.item.why_relevant),
});

/** The compact note on a signal_evidence row. Convenience text only; capped well below the column limit. */
export function mirrorNote(b: EvidenceBundle, itemId: string): string {
  const refs = plannedItems(b)
    .filter((p) => p.item.evidence_item_id === itemId && p.citation.section === "main")
    .flatMap((p) => p.citation.appears_in.map((a) => `${p.item.citation_id} (${a.facet} #${a.rank})`));
  let note = `Cited in evidence bundle ${b.bundle_hash.slice(0, 12)}: ${refs.join(", ")}.`;
  if (note.length > NOTE_MAX) note = `${note.slice(0, note.lastIndexOf(",", NOTE_MAX - 3))} ...`;
  return note;
}

/** Documents the mirror should list: those with a MAIN (current) cited chunk. Historical documents are not current evidence. */
export function mirrorTargets(b: EvidenceBundle): Map<string, string> {
  const ids = new Set(b.citations.filter((c) => c.section === "main").map((c) => c.evidence_item_id));
  return new Map([...ids].sort(compareCodePoints).map((id) => [id, mirrorNote(b, id)]));
}

// ---------------------------------------------------------------- persistence
export interface PersistOptions {
  now?: () => string;
  /** Override how source metadata is resolved for the fallback (tests); defaults to reading the database. */
  resolveMetadata?: MetadataResolver;
}

export interface PersistResult {
  bundleId: string;
  created: boolean;
  runId: string | null;
  items: number;
  explanationId: string;
  explanationCreated: boolean;
  mirror: { inserted: number; updated: number; deleted: number };
}

async function syncMirror(db: EvidenceDb, b: EvidenceBundle): Promise<NonNullable<PersistResult["mirror"]>> {
  if (!db.delete) throw new Error("persistBundle needs a database adapter that supports delete (signal_evidence mirror)");
  const want = mirrorTargets(b);
  const have = new Map((await db.select("signal_evidence", { signal_candidate_id: b.signal.candidate_id }, ["evidence_item_id", "relevance_note"])).map((r) => [r.evidence_item_id as string, (r.relevance_note as string | null) ?? null]));
  let deleted = 0, inserted = 0, updated = 0;
  for (const id of [...have.keys()].filter((k) => !want.has(k))) deleted += await db.delete("signal_evidence", { signal_candidate_id: b.signal.candidate_id, evidence_item_id: id });
  for (const [id, note] of want) {
    if (!have.has(id)) {
      await db.insert("signal_evidence", [{ signal_candidate_id: b.signal.candidate_id, evidence_item_id: id, relevance_note: note }]);
      inserted += 1;
    } else if (have.get(id) !== note) {
      updated += await db.update("signal_evidence", { signal_candidate_id: b.signal.candidate_id, evidence_item_id: id }, { relevance_note: note });
    }
  }
  return { inserted, updated, deleted };
}

async function ensureFallback(db: EvidenceDb, b: EvidenceBundle, bundleId: string, itemRows: Map<string, string>, opts: PersistOptions): Promise<{ id: string; created: boolean; rendered: RenderedFallback | null }> {
  const key = { bundle_id: bundleId, prompt_version: FALLBACK_VERSION, provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL, input_hash: b.bundle_hash };
  let existing = (await db.select("generated_explanations", key, ["id", "output"]))[0];
  let rendered: RenderedFallback | null = null;
  let created = false;
  if (!existing) {
    let resolver = opts.resolveMetadata;
    if (!resolver) {
      const loaded = await loadCitationMetadata(db, bundleVersionIds(b));
      resolver = (id) => loaded.get(id);
    }
    rendered = renderExtractive(b, resolver);
    const checks = validateFallback(b, rendered);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new Error(`extractive fallback failed validation: ${failed.map((f) => f.name).join("; ")}`);
    existing = (await db.insert("generated_explanations", [{
      ...key, model_version: null, params: asJson({}), language: "en", status: "fallback_extractive", output: asJson(rendered.fallback),
      validation_report: asJson({ checks, deterministic: true }), citation_status: "verified",
    }]))[0];
    created = true;
  }
  const out = existing.output as { points?: Array<{ claim_index: number; citation_id: string; excerpt: string }> } | null;
  const points = out?.points ?? rendered?.fallback.points ?? [];
  const have = new Set((await db.select("explanation_citations", { explanation_id: dbId(existing) }, ["claim_index", "bundle_item_id"])).map((r) => `${r.claim_index}|${r.bundle_item_id}`));
  for (const p of points) {
    const itemId = itemRows.get(p.citation_id);
    if (!itemId) throw new Error(`fallback cites ${p.citation_id}, which has no bundle item`);
    if (have.has(`${p.claim_index}|${itemId}`)) continue;
    await db.insert("explanation_citations", [{
      explanation_id: dbId(existing), claim_index: p.claim_index, bundle_item_id: itemId, quote: p.excerpt.slice(0, QUOTE_MAX), anchor_verified: true,
      support_check: asJson({ method: "extractive_verbatim", excerpt_length: p.excerpt.length, quote_truncated: p.excerpt.length > QUOTE_MAX }),
    }]);
  }
  return { id: dbId(existing), created, rendered };
}

export async function persistBundle(db: EvidenceDb, bundle: EvidenceBundle, opts: PersistOptions = {}): Promise<PersistResult> {
  if (bundleHashOf(bundle) !== bundle.bundle_hash) throw new Error("refusing to persist: bundle_hash does not match the bundle's canonical content");
  if (!bundle.corpus.snapshot_id) throw new Error("refusing to persist: a bundle needs the id of the corpus snapshot it was built from (activate a snapshot)");
  const signalId = bundle.signal.candidate_id;
  const now = (opts.now ?? (() => new Date().toISOString()))();

  let bundleRow = (await db.select("evidence_bundles", { signal_candidate_id: signalId, bundle_hash: bundle.bundle_hash }, ["id", "retrieval_run_id"]))[0];
  let created = false;
  let runId: string | null = null;
  if (!bundleRow) {
    runId = dbId((await db.insert("retrieval_runs", [{
      signal_candidate_id: signalId, corpus_snapshot_id: bundle.corpus.snapshot_id, retrieval_version: bundle.config.retrieval_version,
      retrieval_config_hash: bundle.config.retrieval_config_hash, query_vocab_version: bundle.config.query_vocab_version, as_of_date: bundle.config.as_of_date,
      queries: asJson(bundle.facets.map((f) => ({ facet: f.name, topics: f.query_topics, terms: f.query_terms }))), status: "running", started_at: now,
      stats: asJson({ ranking_version: bundle.config.ranking_version, ranking_config_hash: bundle.config.ranking_config_hash, query_hash: bundle.provenance.query_hash, bundle_hash: bundle.bundle_hash }),
    }]))[0]);
    try {
      bundleRow = (await db.insert("evidence_bundles", [{
        retrieval_run_id: runId, signal_candidate_id: signalId, bundle_hash: bundle.bundle_hash, schema_version: bundle.schema_version, bundle: asJson(bundle),
        item_count: bundle.citations.length, gap_count: bundle.gaps.length, conflict_count: bundle.conflicts.length,
      }]))[0];
      created = true;
    } catch (e) {
      // A concurrent writer created the same bundle first (unique per signal + hash): converge on it.
      await db.update("retrieval_runs", { id: runId }, { status: "failed", error: String((e as Error).message).slice(0, 2000), finished_at: now });
      bundleRow = (await db.select("evidence_bundles", { signal_candidate_id: signalId, bundle_hash: bundle.bundle_hash }, ["id", "retrieval_run_id"]))[0];
      if (!bundleRow) throw e;
      runId = null;
    }
  }
  const bundleId = dbId(bundleRow);

  try {
    // Items: insert whichever citation rows are missing (all of them on first write; the gaps after an interrupted write).
    const haveItems = new Map((await db.select("evidence_bundle_items", { bundle_id: bundleId }, ["id", "citation_id"])).map((r) => [r.citation_id as string, dbId(r)]));
    for (const p of plannedItems(bundle)) {
      if (haveItems.has(p.item.citation_id)) continue;
      haveItems.set(p.item.citation_id, dbId((await db.insert("evidence_bundle_items", [itemRow(bundleId, p)]))[0]));
    }
    if (created && runId) await db.update("retrieval_runs", { id: runId }, { status: "succeeded", finished_at: now });

    const fb = await ensureFallback(db, bundle, bundleId, haveItems, opts);
    // A bundle completed by a later call (after an interrupted write) is complete now: its provenance run says so.
    if (!created && bundleRow.retrieval_run_id) {
      const prior = (await db.select("retrieval_runs", { id: bundleRow.retrieval_run_id }, ["id", "status"]))[0];
      if (prior && prior.status !== "succeeded") await db.update("retrieval_runs", { id: dbId(prior) }, { status: "succeeded", error: null, finished_at: now });
    }
    // The caller states that this is the signal's current bundle (the pipeline always persists a fresh build), so the mirror follows
    // it - including when the content returns to an earlier bundle (a curator reverts a tag), which dedup reuses rather than recreates.
    const mirror = await syncMirror(db, bundle);
    return { bundleId, created, runId, items: haveItems.size, explanationId: fb.id, explanationCreated: fb.created, mirror };
  } catch (e) {
    if (created && runId) await db.update("retrieval_runs", { id: runId }, { status: "failed", error: String((e as Error).message).slice(0, 2000), finished_at: now });
    throw e;
  }
}

// ---------------------------------------------------------------- reading and verifying stored bundles
export interface StoredBundle {
  id: string;
  signalId: string;
  bundleHash: string;
  bundle: EvidenceBundle;
  itemCount: number;
  gapCount: number;
  conflictCount: number;
}

/** The signal's most recently CREATED bundle, or the one with the given hash. */
export async function loadStoredBundle(db: EvidenceDb, signalId: string, bundleHash?: string): Promise<StoredBundle | null> {
  const rows = await db.select("evidence_bundles", bundleHash ? { signal_candidate_id: signalId, bundle_hash: bundleHash } : { signal_candidate_id: signalId }, ["id", "signal_candidate_id", "bundle_hash", "bundle", "item_count", "gap_count", "conflict_count", "created_at"]);
  const r = rows.sort((a, b) => compareCodePoints(iso(b.created_at), iso(a.created_at)) || compareCodePoints(dbId(b), dbId(a)))[0];
  if (!r) return null;
  return { id: dbId(r), signalId: r.signal_candidate_id as string, bundleHash: r.bundle_hash as string, bundle: r.bundle as EvidenceBundle, itemCount: Number(r.item_count), gapCount: Number(r.gap_count), conflictCount: Number(r.conflict_count) };
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  /** Not an integrity failure: the corpus has moved on since the bundle was built. */
  stale: Array<{ citation_id: string; reason: string }>;
}

/** Recompute everything that can be recomputed from the database and compare it with what the bundle says. */
export async function verifyStoredBundle(db: EvidenceDb, bundleId: string): Promise<VerifyReport> {
  const problems: string[] = [];
  const stale: VerifyReport["stale"] = [];
  const row = (await db.select("evidence_bundles", { id: bundleId }, ["id", "signal_candidate_id", "bundle_hash", "schema_version", "bundle", "item_count", "gap_count", "conflict_count"]))[0];
  if (!row) return { ok: false, problems: ["bundle not found"], stale };
  const b = row.bundle as EvidenceBundle;
  if (bundleHashOf(b) !== row.bundle_hash) problems.push("stored bundle JSON does not hash to bundle_hash");
  if (b.bundle_hash !== row.bundle_hash) problems.push("bundle.bundle_hash differs from the column");
  if (row.schema_version !== b.schema_version) problems.push("schema_version differs");
  if (Number(row.item_count) !== b.citations.length || Number(row.gap_count) !== b.gaps.length || Number(row.conflict_count) !== b.conflicts.length) problems.push("denormalised counts differ from the bundle");

  const items = await db.select("evidence_bundle_items", { bundle_id: bundleId }, ["id", "evidence_version_id", "chunk_id", "facet", "rank", "citation_id"]);
  const planned = plannedItems(b);
  if (items.length !== planned.length) problems.push(`expected ${planned.length} bundle items, found ${items.length}`);
  const byCitation = new Map(items.map((i) => [i.citation_id as string, i]));
  const chunks = new Map((await db.select("evidence_chunks", { id: planned.map((p) => p.item.chunk_id) }, ["id", "version_id", "text", "chunk_hash"])).map((c) => [dbId(c), c]));
  const versions = new Map((await db.select("evidence_versions", { id: [...new Set(planned.map((p) => p.item.evidence_version_id))] }, ["id", "evidence_item_id", "content_hash", "is_current"])).map((v) => [dbId(v), v]));
  const docs = new Map((await db.select("evidence_items", { id: [...new Set(planned.map((p) => p.item.evidence_item_id))] }, ["id", "status"])).map((d) => [dbId(d), d]));
  for (const p of planned) {
    const id = p.item.citation_id;
    const stored = byCitation.get(id);
    if (!stored) { problems.push(`${id}: no bundle item row`); continue; }
    if (stored.evidence_version_id !== p.item.evidence_version_id || stored.chunk_id !== p.item.chunk_id) problems.push(`${id}: stored (version, chunk) differs from the bundle`);
    if (stored.facet !== p.facet || Number(stored.rank) !== p.rank) problems.push(`${id}: stored facet/rank differs`);
    const chunk = chunks.get(p.item.chunk_id);
    if (!chunk) { problems.push(`${id}: chunk missing`); continue; }
    if (chunk.version_id !== p.item.evidence_version_id) problems.push(`${id}: chunk does not belong to the cited version`);
    if (chunk.text !== p.item.excerpt) problems.push(`${id}: excerpt is not the stored chunk text`);
    if (chunk.chunk_hash !== p.item.chunk_hash) problems.push(`${id}: chunk hash differs`);
    const v = versions.get(p.item.evidence_version_id);
    if (!v) problems.push(`${id}: version missing`);
    else {
      if (v.content_hash !== p.item.version_content_hash) problems.push(`${id}: version content hash differs`);
      if (v.is_current !== true) stale.push({ citation_id: id, reason: "a newer version of this document has been ingested" });
      const d = docs.get(v.evidence_item_id as string);
      if (p.citation.section === "main" && d && d.status !== "current") stale.push({ citation_id: id, reason: `the document is now ${String(d.status)}` });
    }
  }
  return { ok: problems.length === 0, problems, stale };
}

/** Content-addressed fingerprint of resolved metadata, used to detect later edits to titles / publishers / URLs. */
export const metadataFingerprint = (m: Map<string, CitationMetadata>): string => hashJson([...m.entries()].sort((a, b) => compareCodePoints(a[0], b[0])));
