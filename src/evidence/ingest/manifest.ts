// Deterministic corpus manifest and corpus hash. The manifest records, for every document, what the ingestion
// pipeline decided (effective status, scan verdict, hashes of content/metadata/chunks). corpus_hash is the
// SHA-256 of the canonical manifest: it changes iff any document, any rule version or any decision changes.
import { hashJson } from "../hash";
import type { PreparedDocument } from "./prepare";
import { INJECTION_SCANNER_VERSION } from "./inject";
import { SANITISER_VERSION } from "./sanitize";
import { TRUST_RULES_VERSION } from "./trust";

export const MANIFEST_SCHEMA = "corpus-manifest/1";

export interface ManifestEntry {
  canonical_id: string;
  version_label: string;
  status: string;
  declared_status: string;
  trust_level: string;
  source_class: string;
  evidence_kind: string;
  geo_scope: string;
  geo_region_code: string | null;
  language: string;
  is_synthetic: boolean;
  supersedes: string | null;
  content_hash: string;
  metadata_hash: string;
  chunk_hashes: string[];
  scan: { verdict: string; rules: string[] };
  decision_reasons: string[];
}

export interface CorpusManifest {
  schema: typeof MANIFEST_SCHEMA;
  corpus_name: string;
  sanitiser_version: string;
  scanner_version: string;
  trust_rules_version: string;
  counts: { documents: number; chunks: number; synthetic: number; by_status: Record<string, number> };
  entries: ManifestEntry[];
  corpus_hash: string;
}

export function buildManifest(corpusName: string, prepared: PreparedDocument[]): CorpusManifest {
  const entries: ManifestEntry[] = prepared
    .map((p) => ({
      canonical_id: p.doc.canonical_id,
      version_label: p.doc.version_label,
      status: p.decision.status,
      declared_status: p.doc.declared_status,
      trust_level: p.decision.trustLevel,
      source_class: p.doc.source_class,
      evidence_kind: p.doc.evidence_kind,
      geo_scope: p.doc.geo_scope,
      geo_region_code: p.doc.geo_region_code,
      language: p.doc.language,
      is_synthetic: p.doc.is_synthetic,
      supersedes: p.doc.supersedes,
      content_hash: p.contentHash,
      metadata_hash: p.metadataHash,
      chunk_hashes: p.chunks.map((c) => c.chunk_hash),
      scan: { verdict: p.scan.verdict, rules: p.scan.rules },
      decision_reasons: [...p.decision.reasons].sort(),
    }))
    .sort((a, b) => (a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0));

  const by_status: Record<string, number> = {};
  for (const e of entries) by_status[e.status] = (by_status[e.status] ?? 0) + 1;
  const body = {
    schema: MANIFEST_SCHEMA,
    corpus_name: corpusName,
    sanitiser_version: SANITISER_VERSION,
    scanner_version: INJECTION_SCANNER_VERSION,
    trust_rules_version: TRUST_RULES_VERSION,
    counts: {
      documents: entries.length,
      chunks: entries.reduce((n, e) => n + e.chunk_hashes.length, 0),
      synthetic: entries.filter((e) => e.is_synthetic).length,
      by_status,
    },
    entries,
  };
  return { ...body, corpus_hash: hashJson(body) } as CorpusManifest;
}

export interface CorpusValidation {
  errors: string[];
  warnings: string[];
}

/** Cross-document rules. Per-document errors (prepared.errors) are included. */
export function validateCorpus(prepared: PreparedDocument[]): CorpusValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, PreparedDocument>();
  for (const p of prepared) {
    const id = p.doc.canonical_id;
    for (const e of p.errors) errors.push(`${id}: ${e}`);
    if (byId.has(id)) errors.push(`${id}: duplicate canonical_id (one file per document edition)`);
    byId.set(id, p);
  }

  const urls = new Map<string, string>();
  const hashes = new Map<string, string>();
  const successors = new Map<string, string>();
  for (const p of prepared) {
    const id = p.doc.canonical_id;
    if (p.doc.reference_url) {
      const key = p.doc.reference_url.toLowerCase();
      if (urls.has(key)) errors.push(`${id}: reference_url already used by ${urls.get(key)} (one item per URL; use a new version instead)`);
      urls.set(key, id);
    }
    const dup = hashes.get(p.contentHash);
    if (dup) warnings.push(`${id}: identical content to ${dup} (near-duplicate handling is retrieval's job)`);
    else hashes.set(p.contentHash, id);

    const target = p.doc.supersedes;
    if (!target) continue;
    const pred = byId.get(target);
    if (!pred) errors.push(`${id}: supersedes unknown document ${target}`);
    else {
      if (!["superseded", "historical", "withdrawn"].includes(pred.doc.declared_status)) {
        errors.push(`${id}: supersedes ${target}, which must be declared superseded/historical/withdrawn (is ${pred.doc.declared_status})`);
      }
      if (successors.has(target)) errors.push(`${id}: ${target} is already superseded by ${successors.get(target)} (chains must be linear)`);
      successors.set(target, id);
    }
  }
  for (const p of prepared) {
    const seen = new Set<string>([p.doc.canonical_id]);
    for (let cur = p.doc.supersedes; cur; cur = byId.get(cur)?.doc.supersedes ?? null) {
      if (seen.has(cur)) {
        errors.push(`${p.doc.canonical_id}: supersession cycle through ${cur}`);
        break;
      }
      seen.add(cur);
    }
  }
  return { errors: [...new Set(errors)], warnings };
}

/** Predecessors before successors (a successor's supersedes_id must reference an existing row), ties by id. */
export function ingestOrder(prepared: PreparedDocument[]): PreparedDocument[] {
  const byId = new Map(prepared.map((p) => [p.doc.canonical_id, p]));
  const depth = (p: PreparedDocument): number => {
    let d = 0;
    for (let cur = p.doc.supersedes; cur && byId.has(cur) && d < 1000; cur = byId.get(cur)!.doc.supersedes) d += 1;
    return d;
  };
  return [...prepared].sort((a, b) => depth(a) - depth(b) || (a.doc.canonical_id < b.doc.canonical_id ? -1 : 1));
}
