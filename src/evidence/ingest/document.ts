// Corpus document format ("evidence-doc/1"): one JSON file per document edition. The schema is strict (unknown
// keys are rejected) and encodes the provenance rules that keep synthetic documents unmistakably synthetic and
// real documents traceable. It validates structure only; sanitising, scanning and trust decisions happen later.
import { z } from "zod";
import { EVIDENCE_KINDS, EVIDENCE_STATUSES, EVIDENCE_TOPICS, GEO_SCOPES, SOURCE_CLASS_TIERS } from "../vocab";

export const DOCUMENT_SCHEMA = "evidence-doc/1";
export const SOURCE_TYPES = ["guideline", "government_advisory", "peer_reviewed", "situation_report", "dataset", "other"] as const;
export const DOC_SYNDROMES = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness", "other"] as const;
export const VERIFICATION_BASES = ["domain_allowlist", "curator_reviewed", "doi_resolved"] as const;
export const CANONICAL_ID_RE = /^[a-z0-9][a-z0-9._-]{2,119}$/;

/** Hosts that can never be a real publisher (RFC 2606 / 6761 reserved names). Synthetic documents may only use these. */
export function isReservedHost(host: string): boolean {
  const h = host.toLowerCase();
  return /\.(invalid|test|example|localhost)$/.test(h) || /(^|\.)example\.(com|org|net)$/.test(h);
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, "not a real calendar date");

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};

export const corpusDocumentSchema = z
  .object({
    schema: z.literal(DOCUMENT_SCHEMA),
    canonical_id: z.string().regex(CANONICAL_ID_RE),
    version_label: z.string().min(1).max(60),
    title: z.string().min(1).max(300),
    publisher: z.string().min(1).max(200),
    source_type: z.enum(SOURCE_TYPES),
    source_class: z.enum(SOURCE_CLASS_TIERS),
    evidence_kind: z.enum(EVIDENCE_KINDS),
    topics: z.array(z.enum(EVIDENCE_TOPICS as unknown as [string, ...string[]])).min(1).max(12),
    syndromes: z.array(z.enum(DOC_SYNDROMES)).max(6).default([]),
    geo_scope: z.enum(GEO_SCOPES),
    geo_region_code: z.string().regex(/^[A-Z0-9-]{2,60}$/).nullable().default(null),
    language: z.enum(["en", "hi", "or"]),
    publication_date: isoDate.nullable().default(null),
    valid_from: isoDate.nullable().default(null),
    valid_until: isoDate.nullable().default(null),
    review_due: isoDate.nullable().default(null),
    reference_url: z.string().max(2000).nullable().default(null),
    citation: z.string().max(1000).nullable().default(null),
    licence: z.string().max(200).nullable().default(null),
    source_domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/).nullable().default(null),
    verification_basis: z.array(z.enum(VERIFICATION_BASES)).max(3).default([]),
    is_synthetic: z.boolean(),
    trust_level: z.enum(["unreviewed", "reviewed", "trusted"]),
    declared_status: z.enum(EVIDENCE_STATUSES),
    supersedes: z.string().regex(CANONICAL_ID_RE).nullable().default(null),
    /** Curator-authored conflict tags (M4.3): documents sharing a question_key with different positions are reported as a conflict. */
    question_key: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/).nullable().default(null),
    position: z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/).nullable().default(null),
    curator_reviewed: z.object({ on: isoDate }).nullable().default(null),
    /** SHA-256 of the sanitised source text as fetched (printed by `npm run evidence:fetch`). Real documents only. */
    source_content_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
    abstract: z.string().max(8000).default(""),
    excerpts: z.array(z.object({ text: z.string().min(1).max(4000) }).strict()).max(12).default([]),
    translations: z
      .array(
        z.object({
          language: z.enum(["hi", "or"]),
          title: z.string().min(1).max(300),
          abstract: z.string().max(4000).default(""),
          provenance: z.enum(["human", "machine"]),
        }).strict(),
      )
      .max(2)
      .default([]),
    notes: z.string().max(1000).nullable().default(null),
  })
  .strict()
  .superRefine((d, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((d.geo_scope === "state" || d.geo_scope === "district") !== (d.geo_region_code !== null)) {
      bad("geo_region_code", "required for state/district scope and forbidden otherwise");
    }
    if (!d.reference_url && !d.citation) bad("citation", "a reference_url or a citation is required");
    if (new Set(d.topics).size !== d.topics.length) bad("topics", "duplicate topics");
    if (d.valid_from && d.valid_until && d.valid_until < d.valid_from) bad("valid_until", "valid_until is before valid_from");
    if (d.supersedes === d.canonical_id) bad("supersedes", "a document cannot supersede itself");
    if ((d.question_key === null) !== (d.position === null)) bad("position", "question_key and position must be set together or not at all");
    if (!d.abstract.trim() && d.excerpts.length === 0) bad("abstract", "an abstract or at least one excerpt is required");

    const urlHost = d.reference_url ? hostOf(d.reference_url) : null;
    if (d.reference_url && !urlHost) bad("reference_url", "not a valid URL");
    if (d.is_synthetic) {
      if (!/synthetic/i.test(d.publisher)) bad("publisher", 'synthetic documents must have "Synthetic" in the publisher name');
      if (d.citation && !d.citation.startsWith("SYNTHETIC")) bad("citation", 'synthetic citations must start with "SYNTHETIC"');
      if (urlHost && !isReservedHost(urlHost)) bad("reference_url", "synthetic documents may only use reserved hosts (.invalid/.test/.example/example.*)");
      if (d.source_domain && !isReservedHost(d.source_domain)) bad("source_domain", "synthetic documents may only use reserved domains");
      if (d.licence && !/synthetic/i.test(d.licence)) bad("licence", "synthetic documents must not claim a real licence");
      if (d.source_content_hash) bad("source_content_hash", "synthetic documents have no fetched source");
    } else {
      if (!d.source_content_hash) bad("source_content_hash", "real documents need the source hash recorded by evidence:fetch");
      if (!d.reference_url || !d.reference_url.startsWith("https://")) bad("reference_url", "real documents need an https reference_url");
      if (!d.source_domain) bad("source_domain", "real documents need a source_domain");
      if (urlHost && isReservedHost(urlHost)) bad("reference_url", "a real document cannot use a reserved host");
    }
  });

export type CorpusDocument = z.infer<typeof corpusDocumentSchema>;

export interface ParseResult {
  doc: CorpusDocument | null;
  errors: string[];
}

export function parseCorpusDocument(raw: unknown): ParseResult {
  const r = corpusDocumentSchema.safeParse(raw);
  if (r.success) return { doc: r.data, errors: [] };
  return { doc: null, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
