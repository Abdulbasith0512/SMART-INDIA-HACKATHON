// Deterministic extractive fallback: a cited summary built ONLY from the bundle, with no model and no provider.
//
// It repeats the selected excerpts exactly as stored, each tagged with its citation id and followed by source
// metadata that is resolved from the DATABASE through the stored evidence_version_id (never from model text, never
// from the bundle's own copy). Everything the fallback itself writes is a fixed template; excerpts, source metadata
// and gap messages are labelled as such, so a test can prove that the fallback's own wording never diagnoses, names a
// cause, claims an outbreak or gives treatment advice. If evidence is thin or absent, it says so plainly.
//
// This is the baseline that M4.5's model-written explanation is evaluated against.
import { hashJson } from "../hash";
import { FACET_LABEL, SYNDROME_LABEL } from "./reasons";
import { compareCodePoints } from "../retrieval/tokenize";
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import type { BundleItem, EvidenceBundle } from "./types";

export const FALLBACK_SCHEMA = "extractive-fallback/1";
export const FALLBACK_VERSION = "extractive-fallback/1.0.0";
export const FALLBACK_STATUS = "fallback_extractive";
/** Required opening, character for character (the ellipsis is U+2026). */
export const FALLBACK_OPENING = "Evidence relevant to this emerging signal suggests…";
/** "Thin": fewer than this many distinct passages, or fewer than 2 facets covered. */
export const THIN_MIN_PASSAGES = 3;
export const THIN_MIN_FACETS = 2;

/** Patterns the fallback's OWN wording (templates and gap messages) must never match. */
export const FORBIDDEN_FALLBACK_WORDING = /outbreak|epidemic|pandemic|diagnos|confirmed|treat|therap|medicat|prescri|\bdose|\bcure\b|vaccin|caused by|due to|infection|\bpatients?\b/i;

/** Everything the renderer may show about a cited source, resolved from the database by evidence_version_id. */
export interface CitationMetadata {
  evidence_version_id: string;
  title: string;
  publisher: string;
  source_type: string;
  reference_url: string | null;
  citation: string | null;
  publication_date: string | null;
  licence: string | null;
  is_synthetic: boolean;
}
export type MetadataResolver = (evidenceVersionId: string) => CitationMetadata | undefined;

export type PartKind = "template" | "excerpt" | "metadata" | "gap";
export interface Part {
  kind: PartKind;
  text: string;
  citation_id?: string;
}

export interface FallbackPoint {
  claim_index: number;
  citation_id: string;
  facet: QueryFacet | "historical_context";
  excerpt: string;
}
export interface ExtractiveFallback {
  schema: typeof FALLBACK_SCHEMA;
  version: string;
  status: typeof FALLBACK_STATUS;
  bundle_hash: string;
  opening: string;
  thin: boolean;
  points: FallbackPoint[];
  gaps: string[];
  text: string;
  /** Hash of the source metadata that was rendered, so later metadata edits are detectable. */
  metadata_hash: string;
}
export interface RenderedFallback {
  fallback: ExtractiveFallback;
  /** The same text split into labelled parts; used by tests and validation, not persisted. */
  parts: Part[];
}

const syndromeLabel = (s: string): string => SYNDROME_LABEL[s] ?? s;
const scopeLabel = (g: string): string => `${g} scope`;

function sourceLine(item: BundleItem, m: CitationMetadata): Part[] {
  const bits: Part[] = [
    { kind: "template", text: "Source: " },
    { kind: "metadata", text: `${m.title} - ${m.publisher}` },
    { kind: "template", text: `. ${item.tier.label}; ${scopeLabel(item.geo_level)}; ` },
    { kind: "metadata", text: m.publication_date ? `published ${m.publication_date}` : "publication date not recorded" },
  ];
  const ref = m.reference_url ?? m.citation;
  if (ref) bits.push({ kind: "template", text: "; " }, { kind: "metadata", text: ref });
  if (m.is_synthetic) bits.push({ kind: "template", text: "; SYNTHETIC TEST DOCUMENT, not real evidence" });
  bits.push({ kind: "template", text: "." });
  return bits;
}

export function renderExtractive(bundle: EvidenceBundle, resolve: MetadataResolver): RenderedFallback {
  const parts: Part[] = [];
  const points: FallbackPoint[] = [];
  const t = (text: string) => parts.push({ kind: "template", text });
  const used = new Map<string, CitationMetadata>();
  const meta = (item: BundleItem): CitationMetadata => {
    const m = resolve(item.evidence_version_id);
    if (!m) throw new Error(`fallback: no database metadata for evidence version ${item.evidence_version_id} (${item.citation_id})`);
    used.set(item.citation_id, m);
    return m;
  };
  const point = (item: BundleItem, facet: FallbackPoint["facet"], suffix?: string): void => {
    const m = meta(item);
    const claim_index = points.length;
    points.push({ claim_index, citation_id: item.citation_id, facet, excerpt: item.excerpt });
    t(`\n[${item.citation_id}] "`);
    parts.push({ kind: "excerpt", text: item.excerpt, citation_id: item.citation_id });
    t(`"\n    `);
    parts.push(...sourceLine(item, m));
    if (suffix) parts.push({ kind: "metadata", text: ` ${suffix}` });
    t("\n");
  };

  const s = bundle.signal;
  const placeBits = [s.region.name, s.region.district && s.region.district !== s.region.name ? s.region.district : null, s.region.state].filter((x): x is string => !!x);
  t(`${FALLBACK_OPENING}\n\n`);
  t(`Signal: ${syndromeLabel(s.syndrome)} reports in `);
  parts.push({ kind: "metadata", text: placeBits.join(", ") });
  t(`, ${s.window.start} to ${s.window.end}. This is an emerging signal requiring verification.\n`);
  t("The passages below are quoted exactly as stored; nothing has been added to them.\n");

  const empty = bundle.stats.selected_chunks === 0;
  const thin = bundle.stats.selected_chunks < THIN_MIN_PASSAGES || bundle.stats.facets_covered < THIN_MIN_FACETS;
  if (empty) t("\nNo eligible evidence was selected for this signal, so there is nothing to quote.\n");
  else if (thin) t(`\nLimited evidence: only ${bundle.stats.selected_chunks} passage(s) from ${bundle.stats.selected_documents} document(s) were selected, so this summary is incomplete.\n`);

  for (const name of QUERY_FACETS) {
    const f = bundle.facets.find((x) => x.name === name)!;
    t(`\n${FACET_LABEL[name].charAt(0).toUpperCase()}${FACET_LABEL[name].slice(1)}\n`);
    if (f.items.length === 0) t("No eligible evidence was found for this facet.\n");
    for (const item of f.items) point(item, name);
  }

  if (bundle.historical_context.length) {
    t("\nHistorical context (superseded or historical documents, shown for context only and not current evidence)\n");
    for (const h of bundle.historical_context) {
      point(h, "historical_context", h.relation.superseded_by.length ? `Superseded by: ${h.relation.superseded_by.join(", ")}.` : `Document status: ${h.relation.status}.`);
    }
  }

  if (bundle.conflicts.length) {
    t("\nConflicting positions (reported only where curators tagged documents to the same question)\n");
    for (const c of bundle.conflicts) {
      t("Question ");
      parts.push({ kind: "metadata", text: `"${c.question_key}"` });
      t(": ");
      c.positions.forEach((p, i) => {
        if (i) t("; ");
        t("position ");
        parts.push({ kind: "metadata", text: `"${p.position}"` });
        const cited = [...new Set(p.documents.flatMap((d) => d.citation_ids))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        t(cited.length ? ` (${cited.join(", ")})` : "");
      });
      t(".\n");
    }
  }

  const gapMessages = bundle.gaps.map((g) => g.message);
  if (gapMessages.length) {
    t("\nGaps in the evidence\n");
    for (const g of bundle.gaps) {
      t("- ");
      parts.push({ kind: "gap", text: g.message });
      t("\n");
    }
  }
  t("\nThis text only repeats retrieved passages and the details of their sources. It is an emerging signal requiring verification by a public-health officer and is not a finding.\n");

  const text = parts.map((p) => p.text).join("");
  const fallback: ExtractiveFallback = {
    schema: FALLBACK_SCHEMA,
    version: FALLBACK_VERSION,
    status: FALLBACK_STATUS,
    bundle_hash: bundle.bundle_hash,
    opening: FALLBACK_OPENING,
    thin: empty || thin,
    points,
    gaps: gapMessages,
    text,
    metadata_hash: hashJson([...used.entries()].sort((a, b) => compareCodePoints(a[0], b[0])).map(([id, m]) => [id, m])),
  };
  return { fallback, parts };
}

export interface FallbackCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * The text the fallback itself authors (templates and the gap messages M4.3 built from templates), with the data
 * that gap messages embed - region names and curated document ids - removed, so a place or document called
 * "Outbreak Road" or "...outbreak-checklist" cannot be mistaken for the fallback's own claim.
 */
export function ownWording(bundle: EvidenceBundle, parts: readonly Part[]): string[] {
  const embedded = new Set<string>();
  const s = bundle.signal.region;
  for (const n of [s.name, s.district, s.state]) if (n) embedded.add(n);
  for (const g of bundle.gaps) for (const d of (g.basis.documents as string[] | undefined) ?? []) embedded.add(d);
  return parts
    .filter((p) => p.kind === "template" || p.kind === "gap")
    .map((p) => [...embedded].sort((a, b) => b.length - a.length).reduce((txt, e) => txt.split(e).join("·"), p.text));
}

/** Deterministic checks run before a fallback is stored. A failure means a bug, never a model judgement. */
export function validateFallback(bundle: EvidenceBundle, rendered: RenderedFallback): FallbackCheck[] {
  const { fallback, parts } = rendered;
  const checks: FallbackCheck[] = [];
  const byCitation = new Map(bundle.citations.map((c) => [c.citation_id, c]));
  const itemsByCitation = new Map<string, BundleItem>();
  for (const f of bundle.facets) for (const i of f.items) itemsByCitation.set(i.citation_id, i);
  for (const h of bundle.historical_context) itemsByCitation.set(h.citation_id, h);

  checks.push({ name: "opens with the required sentence", ok: fallback.text.startsWith(FALLBACK_OPENING + "\n") });
  checks.push({ name: "every cited id exists in the bundle", ok: fallback.points.every((p) => byCitation.has(p.citation_id)) });
  checks.push({ name: "every excerpt is the bundle's stored chunk text, verbatim", ok: fallback.points.every((p) => itemsByCitation.get(p.citation_id)?.excerpt === p.excerpt) });
  checks.push({ name: "every excerpt part is a quoted stored excerpt with a citation id", ok: parts.filter((p) => p.kind === "excerpt").every((p) => !!p.citation_id && itemsByCitation.get(p.citation_id!)?.excerpt === p.text) });
  checks.push({ name: "no citation id outside the bundle appears in the text", ok: [...fallback.text.matchAll(/\[E(\d+)\]/g)].every((m) => byCitation.has(`E${m[1]}`)) });
  const bad = ownWording(bundle, parts).find((txt) => FORBIDDEN_FALLBACK_WORDING.test(txt));
  checks.push({ name: "the fallback's own wording contains no diagnosis, cause, outbreak or treatment language", ok: !bad, detail: bad });
  checks.push({ name: "gaps are stated exactly as the bundle records them", ok: JSON.stringify(fallback.gaps) === JSON.stringify(bundle.gaps.map((g) => g.message)) });
  checks.push({ name: "an empty or thin result says so", ok: !fallback.thin || /No eligible evidence was selected|Limited evidence/.test(fallback.text) });
  checks.push({ name: "bound to this bundle", ok: fallback.bundle_hash === bundle.bundle_hash });
  return checks;
}
