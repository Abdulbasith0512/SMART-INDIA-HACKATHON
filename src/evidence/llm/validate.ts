// Deterministic validation of parsed model output against the M4.4 bundle. This module, with forbidden.ts and support.ts,
// is the security boundary: the model's output is accepted only as far as it passes here, however the model was prompted.
//
// Per statement (all must hold, otherwise the statement is DROPPED and the drop is recorded):
//   1. every cited id exists in the bundle, was sent to the model, and maps to a passage resolved from the database
//   2. enough citations for the kind (evidence_statement and terminology 1+, synthesis / agreement / disagreement 2+)
//   3. every anchor cites an id of the same statement, is at least 3 words, and is a verbatim substring of that passage
//      under the approved normalisation (NFC + whitespace only); every cited id has at least one anchor
//   4. no steering content (instructions, roles, tools, code, secrets, links, markup) inside an anchor
//   5. the text passes the forbidden-content scan (diagnosis, outbreak confirmation, treatment and response advice,
//      instructions, causal claims the source does not make, links, markup, hidden or non-English text)
//   6. no citation id in the text that the statement does not cite
//   7. every number, date, named entity and controlled term in the text appears in the statement's verified anchors or in
//      the approved signal facts
// The whole generation is REFUSED (not partially salvaged) when: steering content appears anywhere (the model was hijacked or is
// acting); no statement survives; or more than the permitted share of statements had to be dropped.
import type { EvidenceBundle } from "../bundle/types";
import { sha256Hex } from "../hash";
import { scanAnchor, scanModelText } from "./forbidden";
import { anchorStatus, foldForScan } from "./normalize";
import { checkSupport, lexicalCoverage, type SupportReport } from "./support";
import { GENERATION_LEVEL, UNSUPPORTED, type Failure, type FailureCategory, type ModelOutput, type ModelPoint, type PassageMap, type PointKind } from "./types";

export interface ValidationPolicy {
  /** Refuse the whole generation when MORE than this share of statements had to be dropped. */
  maxDropFraction: number;
}
export const DEFAULT_POLICY: ValidationPolicy = { maxDropFraction: 0.5 };

export const MIN_CITATIONS: Record<PointKind, number> = { evidence_statement: 1, terminology: 1, synthesis: 2, agreement: 2, disagreement: 2 };

export interface KeptPoint extends ModelPoint {
  /** Position in the model's answer (dropped statements leave gaps in this numbering). */
  index: number;
  support: {
    numbers_checked: number;
    dates_checked: number;
    entities_checked: number;
    terms_checked: number;
    /** Share of content words found in the cited passages. Recorded for audit; never used as proof of support. */
    lexical_coverage: number;
  };
}
export interface DroppedItem {
  where: string;
  kind?: string;
  text_sha256: string;
  text_length: number;
  categories: FailureCategory[];
}

export interface ValidationOutcome {
  accepted: boolean;
  /** Why the whole generation was refused; null when accepted. */
  rejection: FailureCategory | null;
  kept: KeptPoint[];
  dropped: DroppedItem[];
  uncertainties: string[];
  missing_evidence: string[];
  failures: Failure[];
  categories: Partial<Record<FailureCategory, number>>;
  counts: { points_total: number; points_kept: number; points_dropped: number; citations_kept: number; unsupported_claims: number; forbidden_claims: number };
}

export interface ValidationInput {
  bundle: EvidenceBundle;
  /** Passages resolved from the database by the bundle's stored ids. */
  passages: PassageMap;
  /** Citation ids that were actually sent to the model (only these are citable). */
  sent: ReadonlySet<string>;
  /** The signal facts block as sent (the only non-evidence text that may support a number, date or name). */
  factsText: string;
  output: ModelOutput;
  policy?: ValidationPolicy;
}

const CITATION_IN_TEXT = /\bE\d+\b/g;
const isForbidden = (c: FailureCategory): boolean => c.startsWith("forbidden_") || c === "hidden_unicode" || c === "non_english_text";

function supportFailures(r: SupportReport, where: string): Failure[] {
  const out: Failure[] = [];
  if (r.numbers.unsupported.length) out.push({ category: "unsupported_number", where, detail: "number" });
  if (r.dates.unsupported.length) out.push({ category: "unsupported_date", where, detail: "date" });
  if (r.entities.unsupported.length) out.push({ category: "unsupported_entity", where, detail: "name" });
  if (r.terms.unsupported.length) out.push({ category: "unsupported_terminology", where, detail: "term" });
  return out;
}

interface PointResult {
  failures: Failure[];
  support: KeptPoint["support"];
}

function validatePoint(point: ModelPoint, i: number, input: ValidationInput): PointResult {
  const { bundle, passages, sent, factsText } = input;
  const failures: Failure[] = [];
  const at = `points[${i}]`;
  const known = new Map(bundle.citations.map((c) => [c.citation_id, c]));

  // 1. citations
  const citable: string[] = [];
  for (const id of point.citations) {
    if (!known.has(id) || !passages.has(id)) failures.push({ category: "citation_unknown", where: `${at}.citations`, detail: id });
    else if (!sent.has(id)) failures.push({ category: "citation_withheld", where: `${at}.citations`, detail: id });
    else citable.push(id);
  }
  // 2. count for kind
  if (point.citations.length < MIN_CITATIONS[point.kind]) failures.push({ category: "citation_count", where: `${at}.citations`, detail: point.kind });

  // 3-4. anchors
  const verified: string[] = [];
  const anchored = new Set<string>();
  point.anchors.forEach((a, j) => {
    const w = `${at}.anchors[${j}]`;
    if (!point.citations.includes(a.citation)) {
      failures.push({ category: "anchor_citation_mismatch", where: w, detail: a.citation });
      return;
    }
    const passage = citable.includes(a.citation) ? passages.get(a.citation) : undefined;
    if (!passage) return; // the citation itself already failed
    const status = anchorStatus(passage.text, a.quote);
    if (status === "too_short") failures.push({ category: "anchor_too_short", where: w });
    else if (status === "not_verbatim") failures.push({ category: "anchor_not_verbatim", where: w });
    else {
      const steering = scanAnchor(a.quote);
      if (steering.length) {
        failures.push({ category: "anchor_forbidden_content", where: w, detail: steering[0].rule });
        for (const f of steering) if (GENERATION_LEVEL.has(f.category)) failures.push({ category: f.category, where: w, detail: f.rule });
      } else {
        verified.push(a.quote);
        anchored.add(a.citation);
      }
    }
  });
  for (const id of citable) if (!anchored.has(id)) failures.push({ category: "citation_without_anchor", where: `${at}.anchors`, detail: id });

  // 5. forbidden content in the text (causal wording is allowed only where this statement's own anchors use it)
  for (const f of scanModelText(point.text, { anchorText: foldForScan(verified.join(" ")) })) failures.push({ category: f.category, where: `${at}.text`, detail: f.rule });

  // 6. citation-looking ids in the text that the statement does not cite
  for (const m of point.text.matchAll(CITATION_IN_TEXT)) if (!point.citations.includes(m[0])) failures.push({ category: "fabricated_citation", where: `${at}.text`, detail: m[0] });

  // 7. numbers, dates, names, terms: supported by verified anchors or the signal facts
  const report = checkSupport(point.text.replace(/\[E\d+\]/g, " "), [...verified, factsText]);
  failures.push(...supportFailures(report, `${at}.text`));

  return {
    failures,
    support: {
      numbers_checked: report.numbers.checked,
      dates_checked: report.dates.checked,
      entities_checked: report.entities.checked,
      terms_checked: report.terms.checked,
      lexical_coverage: lexicalCoverage(point.text, citable.map((id) => passages.get(id)!.text)),
    },
  };
}

/** Uncertainty and missing-evidence notes carry no citations: they may use only the signal facts and the engine's own gap messages. */
function validateNote(text: string, where: string, input: ValidationInput): Failure[] {
  const out: Failure[] = [];
  for (const f of scanModelText(text)) out.push({ category: f.category, where, detail: f.rule });
  if (/\bE\d+\b/.test(text)) out.push({ category: "fabricated_citation", where });
  out.push(...supportFailures(checkSupport(text, [input.factsText, ...input.bundle.gaps.map((g) => g.message)]), where));
  return out;
}

export function validateOutput(input: ValidationInput): ValidationOutcome {
  const policy = input.policy ?? DEFAULT_POLICY;
  const failures: Failure[] = [];
  const kept: KeptPoint[] = [];
  const dropped: DroppedItem[] = [];

  input.output.points.forEach((p, i) => {
    const r = validatePoint(p, i, input);
    failures.push(...r.failures);
    if (r.failures.length === 0) kept.push({ ...p, index: i, support: r.support });
    else dropped.push({ where: `points[${i}]`, kind: p.kind, text_sha256: sha256Hex(p.text), text_length: p.text.length, categories: [...new Set(r.failures.map((f) => f.category))] });
  });

  const keepNotes = (field: "uncertainties" | "missing_evidence"): string[] => {
    const ok: string[] = [];
    input.output[field].forEach((t, i) => {
      const f = validateNote(t, `${field}[${i}]`, input);
      failures.push(...f);
      if (f.length === 0) ok.push(t);
      else dropped.push({ where: `${field}[${i}]`, text_sha256: sha256Hex(t), text_length: t.length, categories: [...new Set(f.map((x) => x.category))] });
    });
    return ok;
  };
  const uncertainties = keepNotes("uncertainties");
  const missing_evidence = keepNotes("missing_evidence");

  const categories: Partial<Record<FailureCategory, number>> = {};
  for (const f of failures) categories[f.category] = (categories[f.category] ?? 0) + 1;

  const total = input.output.points.length;
  const droppedPoints = dropped.filter((d) => d.where.startsWith("points[")).length;
  let rejection: FailureCategory | null = failures.find((f) => GENERATION_LEVEL.has(f.category))?.category ?? null;
  if (!rejection && kept.length === 0) rejection = "no_valid_points";
  if (!rejection && total > 0 && droppedPoints / total > policy.maxDropFraction) rejection = "too_many_dropped";

  const droppedWithCategories = dropped.filter((d) => d.where.startsWith("points["));
  return {
    accepted: rejection === null,
    rejection,
    kept,
    dropped,
    uncertainties,
    missing_evidence,
    failures,
    categories,
    counts: {
      points_total: total,
      points_kept: kept.length,
      points_dropped: droppedPoints,
      citations_kept: new Set(kept.flatMap((p) => p.citations)).size,
      unsupported_claims: droppedWithCategories.filter((d) => d.categories.some((c) => UNSUPPORTED.has(c))).length,
      forbidden_claims: droppedWithCategories.filter((d) => d.categories.some(isForbidden)).length,
    },
  };
}
