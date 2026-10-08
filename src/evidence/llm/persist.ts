// Persistence of grounded explanations (service role only), in the EXISTING M4.0 tables:
//
//   generated_explanations     one row per (bundle, prompt version, provider, model, input hash): status `validated` with the
//                              validated output, or `rejected` (the model answered but no answer passed) with the validation
//                              report. Append-only. The M4.4 `fallback_extractive` row for the same bundle already exists.
//   generated_explanation_raw  the raw model answers of every attempt. ADMIN-ONLY (row-level security), never copied elsewhere.
//   explanation_citations      one row per (statement, cited passage): the bundle item, the verbatim anchor, the support check.
//
// Idempotent and cached: the same bundle + prompt version + provider + model + input hash is never generated twice (the
// stored output is the reproducibility record - temperature 0 does not make a model deterministic). Convergent: an
// interrupted write is completed by running the same call again. An outage is NOT stored: it is not a property of the
// bundle and must not occupy the idempotency key; the M4.4 fallback is what the officer sees.
import { loadCitationMetadata, plannedItems, verifyStoredBundle } from "../bundle/persist";
import type { CitationMetadata, MetadataResolver } from "../bundle/fallback";
import type { EvidenceBundle } from "../bundle/types";
import { hashJson } from "../hash";
import { asJson, type EvidenceDb, type Row } from "../ingest/ingest";
import { compareCodePoints } from "../retrieval/tokenize";
import { generateExplanation, type GenerateOptions, type GenerationResult, type ValidatedExplanation } from "./generate";
import { GENERATION_PARAMS, inputHashOf, PROMPT_HASH, PROMPT_VERSION, PromptError, selectPassages, signalFactsText } from "./prompt";
import { renderExplanation } from "./render";
import { validateOutput } from "./validate";
import type { LlmProvider, ModelOutput, Passage, PassageMap, PointKind } from "./types";

const dbId = (r: Row): string => r.id as string;
const QUOTE_MAX = 600;
const RAW_MAX_TOTAL = 190_000;
export const REPORT_SCHEMA = "m4.5-validation/1";

export interface LoadedBundle {
  id: string;
  signalId: string;
  bundle: EvidenceBundle;
  /** Passage text read from the database through the bundle items' stored (version, chunk) ids. */
  passages: PassageMap;
  /** citation id -> evidence_bundle_items.id */
  itemIds: Map<string, string>;
  metadata: Map<string, CitationMetadata>;
}

/** Load a stored bundle, verify it against the database, and resolve every passage and source detail by its stored ids. */
export async function loadBundleForGeneration(db: EvidenceDb, bundleId: string): Promise<LoadedBundle> {
  const row = (await db.select("evidence_bundles", { id: bundleId }, ["id", "signal_candidate_id", "bundle_hash", "bundle"]))[0];
  if (!row) throw new Error(`bundle ${bundleId} not found`);
  const verification = await verifyStoredBundle(db, bundleId);
  if (!verification.ok) throw new Error(`stored bundle failed verification: ${verification.problems.join("; ")}`);
  const bundle = row.bundle as EvidenceBundle;

  const items = await db.select("evidence_bundle_items", { bundle_id: bundleId }, ["id", "citation_id", "evidence_version_id", "chunk_id"]);
  const itemIds = new Map(items.map((i) => [i.citation_id as string, dbId(i)]));
  const chunkText = new Map((await db.select("evidence_chunks", { id: [...new Set(items.map((i) => i.chunk_id as string))] }, ["id", "text"])).map((c) => [dbId(c), c.text as string]));
  const excerpts = new Map(plannedItems(bundle).map((p) => [p.item.citation_id, p.item.excerpt]));

  const passages = new Map<string, Passage>();
  for (const c of bundle.citations) {
    const item = items.find((i) => i.citation_id === c.citation_id);
    const text = chunkText.get(c.chunk_id);
    if (!item || item.chunk_id !== c.chunk_id || item.evidence_version_id !== c.evidence_version_id) throw new Error(`${c.citation_id} does not map to the stored (version, chunk)`);
    if (text === undefined || text !== excerpts.get(c.citation_id)) throw new Error(`${c.citation_id}: the stored chunk text differs from the bundle's excerpt`);
    passages.set(c.citation_id, { citation_id: c.citation_id, evidence_version_id: c.evidence_version_id, chunk_id: c.chunk_id, text, facets: c.appears_in.map((a) => a.facet) });
  }
  const metadata = await loadCitationMetadata(db, bundle.citations.map((c) => c.evidence_version_id));
  return { id: bundleId, signalId: row.signal_candidate_id as string, bundle, passages, itemIds, metadata };
}

// ---------------------------------------------------------------- reports and raw output
export function buildReport(result: GenerationResult, bundleHash: string): Record<string, unknown> {
  return {
    schema: REPORT_SCHEMA,
    decision: result.status,
    deterministic_validators: true,
    bundle_hash: bundleHash,
    prompt_version: result.prompt_version,
    prompt_hash: result.prompt_hash,
    provider: result.provider,
    model: result.model,
    model_version: result.model_version,
    params: result.params,
    input_hash: result.input_hash,
    output_hash: result.output_hash,
    attempts: result.attempts.map((a) => ({
      attempt: a.attempt, outcome: a.outcome, provider_error: a.provider_error, request_sha256: a.request_sha256, raw_sha256: a.raw_sha256, raw_length: a.raw_length,
      finish_reason: a.finish_reason, model_version: a.model_version, usage: a.usage, parse: a.parse, schema_issues: a.schema_issues, rejection: a.rejection,
      categories: a.categories, counts: a.counts, dropped: a.dropped, withheld: a.withheld, latency_ms: a.latency_ms,
    })),
    render_checks: result.render_checks,
    metrics: result.metrics,
    note: "No model text appears in this report. Raw model output is stored only in generated_explanation_raw (administrators only).",
  };
}

function rawPayload(result: GenerationResult): string | null {
  const got = result.attempts.filter((a) => a.raw !== null);
  if (!got.length) return null;
  const each = Math.floor(RAW_MAX_TOTAL / got.length) - 200;
  return JSON.stringify({ attempts: got.map((a) => ({ attempt: a.attempt, raw: (a.raw as string).slice(0, each), truncated: (a.raw as string).length > each })) });
}

// ---------------------------------------------------------------- citation rows
interface CitationRow {
  claim_index: number;
  citation_id: string;
  quote: string;
  support: Record<string, unknown>;
}

export function citationRows(explanation: ValidatedExplanation): CitationRow[] {
  const rows: CitationRow[] = [];
  explanation.points.forEach((p, claim) => {
    for (const id of p.citations) {
      const anchors = p.anchors.filter((a) => a.citation === id);
      rows.push({
        claim_index: claim,
        citation_id: id,
        quote: anchors[0].quote.slice(0, QUOTE_MAX),
        support: {
          method: "normalised_verbatim_substring",
          normalisation: "NFC + whitespace collapsing only",
          point_kind: p.kind,
          model_point_index: p.index,
          anchors: anchors.map((a) => ({ quote_sha256: hashJson(a.quote), length: a.quote.length })),
          numbers_checked: p.support.numbers_checked,
          dates_checked: p.support.dates_checked,
          entities_checked: p.support.entities_checked,
          terms_checked: p.support.terms_checked,
          lexical_coverage: p.support.lexical_coverage,
        },
      });
    }
  });
  return rows;
}

async function ensureCitations(db: EvidenceDb, explanationId: string, explanation: ValidatedExplanation, itemIds: ReadonlyMap<string, string>): Promise<number> {
  const have = new Set((await db.select("explanation_citations", { explanation_id: explanationId }, ["claim_index", "bundle_item_id"])).map((r) => `${r.claim_index}|${r.bundle_item_id}`));
  let inserted = 0;
  for (const r of citationRows(explanation)) {
    const item = itemIds.get(r.citation_id);
    if (!item) throw new Error(`${r.citation_id} has no bundle item`);
    if (have.has(`${r.claim_index}|${item}`)) continue;
    try {
      await db.insert("explanation_citations", [{ explanation_id: explanationId, claim_index: r.claim_index, bundle_item_id: item, quote: r.quote, anchor_verified: true, support_check: asJson(r.support) }]);
      inserted += 1;
    } catch (e) {
      // A concurrent writer stored this row first (unique per explanation, statement and passage): that is the same row, so converge.
      const stored = await db.select("explanation_citations", { explanation_id: explanationId, bundle_item_id: item }, ["claim_index", "bundle_item_id"]);
      if (!stored.some((s) => Number(s.claim_index) === r.claim_index)) throw e;
    }
  }
  return inserted;
}

// ---------------------------------------------------------------- explaining a stored bundle
export interface ExplainOutcome {
  /** The generation that was run now; null when the stored result was served from the cache (no provider call). */
  generation: GenerationResult | null;
  cached: boolean;
  status: "validated" | "rejected" | "unavailable" | "skipped";
  /** The generated_explanations row for the model's answer; null when nothing was stored (outage, empty bundle, no provider). */
  explanationId: string | null;
  providerCalls: number;
}

async function findRow(db: EvidenceDb, bundleId: string, provider: LlmProvider, inputHash: string): Promise<Row | undefined> {
  return (await db.select("generated_explanations", { bundle_id: bundleId, prompt_version: PROMPT_VERSION, provider: provider.id, model: provider.model, input_hash: inputHash }, ["id", "status", "output"]))[0];
}

export async function explainStoredBundle(db: EvidenceDb, bundleId: string, provider: LlmProvider | null, opts: { generate?: GenerateOptions } = {}): Promise<ExplainOutcome> {
  const loaded = await loadBundleForGeneration(db, bundleId);
  const resolve: MetadataResolver = (id) => loaded.metadata.get(id);

  // Cache: the same inputs are never generated twice.
  let inputHash: string | null = null;
  if (provider) {
    try {
      inputHash = inputHashOf(loaded.bundle, loaded.passages, selectPassages(loaded.bundle, loaded.passages).sent);
    } catch (e) {
      if (!(e instanceof PromptError)) throw e;
    }
    if (inputHash) {
      const hit = await findRow(db, bundleId, provider, inputHash);
      if (hit) {
        if (hit.status === "validated" && hit.output) await ensureCitations(db, dbId(hit), hit.output as ValidatedExplanation, loaded.itemIds);
        return { generation: null, cached: true, status: hit.status as "validated" | "rejected", explanationId: dbId(hit), providerCalls: 0 };
      }
    }
  }

  const result = await generateExplanation({ bundle: loaded.bundle, passages: loaded.passages, provider, resolveMetadata: resolve, options: opts.generate });
  const providerCalls = result.attempts.length;
  if (result.status === "unavailable" || result.status === "skipped") return { generation: result, cached: false, status: result.status, explanationId: null, providerCalls };

  const report = buildReport(result, loaded.bundle.bundle_hash);
  let rowId: string;
  try {
    const row = (await db.insert("generated_explanations", [{
      bundle_id: bundleId, provider: result.provider!, model: result.model!, model_version: result.model_version, prompt_version: PROMPT_VERSION,
      params: asJson(GENERATION_PARAMS), input_hash: result.input_hash!, language: "en", status: result.status === "validated" ? "validated" : "rejected",
      output: result.explanation ? asJson(result.explanation) : null, validation_report: asJson(report), citation_status: "verified",
    }]))[0];
    rowId = dbId(row);
    const raw = rawPayload(result);
    if (raw) await db.insert("generated_explanation_raw", [{ explanation_id: rowId, raw }]);
  } catch (e) {
    // A concurrent writer stored the same inputs first (unique key): converge on that row instead of failing.
    const existing = await findRow(db, bundleId, provider!, result.input_hash!);
    if (!existing) throw e;
    rowId = dbId(existing);
  }
  if (result.explanation) await ensureCitations(db, rowId, result.explanation, loaded.itemIds);
  return { generation: result, cached: false, status: result.status, explanationId: rowId, providerCalls };
}

/** What an officer should be shown for a bundle: the newest validated model explanation, otherwise the M4.4 extractive fallback. */
export async function selectExplanation(db: EvidenceDb, bundleId: string): Promise<{ kind: "validated" | "fallback_extractive"; id: string; provider: string; model: string; output: unknown } | null> {
  const rows = (await db.select("generated_explanations", { bundle_id: bundleId }, ["id", "provider", "model", "status", "output", "created_at"]))
    .sort((a, b) => compareCodePoints(String(b.created_at), String(a.created_at)) || compareCodePoints(dbId(b), dbId(a)));
  const pick = rows.find((r) => r.status === "validated") ?? rows.find((r) => r.status === "fallback_extractive");
  return pick ? { kind: pick.status as "validated" | "fallback_extractive", id: dbId(pick), provider: pick.provider as string, model: pick.model as string, output: pick.output } : null;
}

// ---------------------------------------------------------------- re-validation of a stored explanation
export interface RevalidationReport {
  ok: boolean;
  problems: string[];
  /** Not an integrity failure: something the explanation was built from has changed since. */
  stale: string[];
}

/** Re-run the deterministic validators on a stored explanation against the database as it is now. */
export async function revalidateStoredExplanation(db: EvidenceDb, explanationId: string): Promise<RevalidationReport> {
  const problems: string[] = [];
  const stale: string[] = [];
  const row = (await db.select("generated_explanations", { id: explanationId }, ["id", "bundle_id", "status", "output", "validation_report", "input_hash", "prompt_version"]))[0];
  if (!row) return { ok: false, problems: ["explanation not found"], stale };
  if (row.status !== "validated" || !row.output) return { ok: false, problems: [`explanation status is ${String(row.status)}, not validated`], stale };
  const explanation = row.output as ValidatedExplanation;
  const report = row.validation_report as { output_hash?: string };
  if (report.output_hash !== hashJson(explanation)) problems.push("the stored output no longer hashes to the recorded output_hash");

  const loaded = await loadBundleForGeneration(db, row.bundle_id as string);
  if (explanation.bundle_hash !== loaded.bundle.bundle_hash) problems.push("the explanation belongs to a different bundle hash");
  const sent = new Set(selectPassages(loaded.bundle, loaded.passages).sent);
  const output: ModelOutput = {
    points: explanation.points.map((p) => ({ text: p.text, kind: p.kind as PointKind, citations: p.citations, anchors: p.anchors })),
    uncertainties: explanation.uncertainties,
    missing_evidence: explanation.missing_evidence,
  };
  const again = validateOutput({ bundle: loaded.bundle, passages: loaded.passages, sent, factsText: signalFactsText(loaded.bundle), output });
  if (!again.accepted || again.dropped.length) problems.push(`the stored statements no longer pass the validators (${Object.keys(again.categories).join(", ") || again.rejection})`);

  const stored = await db.select("explanation_citations", { explanation_id: explanationId }, ["claim_index", "bundle_item_id", "quote", "anchor_verified"]);
  const expected = citationRows(explanation);
  if (stored.length !== expected.length) problems.push(`expected ${expected.length} citation rows, found ${stored.length}`);
  for (const e of expected) {
    const s = stored.find((r) => Number(r.claim_index) === e.claim_index && r.bundle_item_id === loaded.itemIds.get(e.citation_id));
    if (!s) problems.push(`claim ${e.claim_index}: no citation row for ${e.citation_id}`);
    else if (s.quote !== e.quote || s.anchor_verified !== true) problems.push(`claim ${e.claim_index}: the stored quote differs from the validated anchor`);
  }

  const kept = again.kept;
  const rendered = renderExplanation({ bundle: loaded.bundle, kept, uncertainties: again.uncertainties, missing_evidence: again.missing_evidence, passages: loaded.passages, resolve: (id) => loaded.metadata.get(id) });
  if (rendered.text !== explanation.text) stale.push("the rendered text differs from the stored text: source details (title, publisher, URL or date) have changed since it was generated");
  return { ok: problems.length === 0, problems, stale };
}

export { PROMPT_HASH, PROMPT_VERSION };
