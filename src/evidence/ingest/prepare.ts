// Prepare one corpus document for ingestion: sanitise every text field, scan it, decide its effective trust
// state, chunk it and hash it. Pure and deterministic: the same document + allow-list always yields identical
// output (this is what makes the corpus hash reproducible).
import { hashJson } from "../hash";
import { buildChunks, ChunkError, type ChunkSpec } from "./chunk";
import type { CorpusDocument } from "./document";
import { scanForInjection, type ScanResult } from "./inject";
import { sanitizeText, type RemovedFragment, type SanitiseReport } from "./sanitize";
import { decideEffectiveState, EMPTY_ALLOWLIST, type Allowlist, type TrustDecision } from "./trust";

export interface PreparedDocument {
  doc: CorpusDocument;
  fields: {
    title: string;
    publisher: string;
    citation: string | null;
    licence: string | null;
    abstract: string;
    excerpts: string[];
    translations: Array<{ language: "hi" | "or"; title: string; abstract: string; provenance: "human" | "machine" }>;
  };
  chunks: ChunkSpec[];
  contentHash: string;
  metadataHash: string;
  scan: ScanResult;
  decision: TrustDecision;
  sanitise: SanitiseReport;
  /** Problems found after sanitising (empty field, oversize text, bad chunks). A document with errors is never ingested. */
  errors: string[];
}

const NUMERIC_KEYS: Array<keyof SanitiseReport> = [
  "inputLength", "outputLength", "htmlCommentsRemoved", "scriptStyleBlocksRemoved", "hiddenElementsRemoved", "hiddenMarkers",
  "htmlTagsRemoved", "entitiesDecoded", "controlCharsRemoved", "invisibleCharsRemoved", "bidiControlsRemoved", "tagCharsRemoved",
  "joinersRemoved", "loneSurrogatesReplaced",
];

function emptyTotals(): SanitiseReport {
  return Object.fromEntries(NUMERIC_KEYS.map((k) => [k, 0])) as unknown as SanitiseReport;
}

export function prepareDocument(doc: CorpusDocument, allowlist: Allowlist = EMPTY_ALLOWLIST): PreparedDocument {
  const totals = emptyTotals();
  const fragments: RemovedFragment[] = [];
  const clean = (s: string): string => {
    const r = sanitizeText(s);
    for (const k of NUMERIC_KEYS) totals[k] += r.report[k];
    fragments.push(...r.removedFragments);
    return r.text;
  };
  const oneLine = (s: string): string => clean(s).replace(/\s*\n\s*/g, " ").trim();
  const errors: string[] = [];

  const fields: PreparedDocument["fields"] = {
    title: oneLine(doc.title),
    publisher: oneLine(doc.publisher),
    citation: doc.citation === null ? null : oneLine(doc.citation),
    licence: doc.licence === null ? null : oneLine(doc.licence),
    abstract: clean(doc.abstract),
    excerpts: doc.excerpts.map((e) => clean(e.text)),
    translations: doc.translations.map((t) => ({ language: t.language, title: oneLine(t.title), abstract: clean(t.abstract), provenance: t.provenance })),
  };
  totals.outputLength = [fields.title, fields.publisher, fields.citation ?? "", fields.licence ?? "", fields.abstract, ...fields.excerpts].join("").length;

  if (!fields.title) errors.push("title is empty after sanitising");
  if (!fields.publisher) errors.push("publisher is empty after sanitising");
  if (fields.title.length > 300) errors.push("title exceeds 300 characters");
  if (fields.publisher.length > 200) errors.push("publisher exceeds 200 characters");
  if (fields.citation !== null && fields.citation.length > 1000) errors.push("citation exceeds 1000 characters");
  if (fields.licence !== null && fields.licence.length > 200) errors.push("licence exceeds 200 characters");
  if (!doc.reference_url && !fields.citation) errors.push("no reference_url and citation is empty after sanitising");
  if (fields.abstract.length > 4000) errors.push("abstract exceeds 4000 characters after sanitising");
  fields.translations.forEach((t, i) => {
    if (!t.title) errors.push(`translation ${i} title is empty after sanitising`);
  });

  let chunks: ChunkSpec[] = [];
  try {
    chunks = buildChunks(fields.abstract, fields.excerpts);
  } catch (e) {
    if (!(e instanceof ChunkError)) throw e;
    errors.push(e.message);
  }

  const scanText = [fields.title, fields.publisher, fields.citation ?? "", fields.licence ?? "", fields.abstract, ...fields.excerpts,
    ...fields.translations.flatMap((t) => [t.title, t.abstract])].filter(Boolean).join("\n");
  const scan = scanForInjection(scanText, { report: totals, removedFragments: fragments, language: doc.language });
  const decision = decideEffectiveState(doc, scan, allowlist);

  // The version hash covers the curated text AND the source hash, so a change to either yields a new version.
  const contentHash = hashJson({ v: "content/1", abstract: fields.abstract, excerpts: fields.excerpts, source: doc.source_content_hash });
  const metadataHash = hashJson({
    v: "metadata/1", title: fields.title, publisher: fields.publisher, citation: fields.citation, licence: fields.licence,
    source_type: doc.source_type, source_class: doc.source_class, evidence_kind: doc.evidence_kind,
    topics: [...doc.topics].sort(), syndromes: [...doc.syndromes].sort(), geo_scope: doc.geo_scope, geo_region_code: doc.geo_region_code,
    language: doc.language, publication_date: doc.publication_date, valid_from: doc.valid_from, valid_until: doc.valid_until,
    review_due: doc.review_due, reference_url: doc.reference_url, source_domain: doc.source_domain,
    verification_basis: [...doc.verification_basis].sort(), is_synthetic: doc.is_synthetic, trust_level: decision.trustLevel,
    supersedes: doc.supersedes, translations: fields.translations,
    // Conflict tags are hashed only when present, so the hash of every untagged document is unchanged.
    ...(doc.question_key !== null ? { question_key: doc.question_key, position: doc.position } : {}),
  });

  return { doc, fields, chunks, contentHash, metadataHash, scan, decision, sanitise: totals, errors };
}
