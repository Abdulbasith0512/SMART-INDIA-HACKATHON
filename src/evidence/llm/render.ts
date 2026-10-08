// Deterministic rendering of a VALIDATED explanation. Everything the system writes itself is a fixed template; the model's
// statements, the verbatim quotes and passages, the database metadata and the engine's gap messages are all labelled parts,
// so tests can prove that the system's own wording never diagnoses, names a cause, claims an outbreak or advises treatment,
// and that the explanation opens with the required sentence (which the model cannot replace: it is not model output).
//
// Evidence and synthesis are rendered in separate, labelled sections. The engine's gaps are always shown first under
// "Missing evidence", exactly as the bundle records them; the model's own notes follow and are labelled as the model's.
import { ownWording, FALLBACK_OPENING, THIN_MIN_FACETS, THIN_MIN_PASSAGES, type CitationMetadata, type MetadataResolver, type Part } from "../bundle/fallback";
import { SYNDROME_LABEL } from "../bundle/reasons";
import type { BundleItem, EvidenceBundle } from "../bundle/types";
import { FORBIDDEN_FALLBACK_WORDING } from "../bundle/fallback";
import { scanAnchor } from "./forbidden";
import type { KeptPoint } from "./validate";
import type { PassageMap } from "./types";

export type RenderKind = "template" | "model" | "quote" | "excerpt" | "metadata" | "gap";
export interface RenderPart {
  kind: RenderKind;
  text: string;
  citation_id?: string;
}
export interface RenderedExplanation {
  text: string;
  parts: RenderPart[];
  thin: boolean;
  cited: string[];
}

export interface RenderInput {
  bundle: EvidenceBundle;
  kept: readonly KeptPoint[];
  uncertainties: readonly string[];
  missing_evidence: readonly string[];
  passages: PassageMap;
  resolve: MetadataResolver;
}

const citationNumber = (id: string): number => Number(id.slice(1));

/** Shown instead of a cited passage that itself carries instruction-like text, links or markup (the stored evidence record keeps the original). */
export const PASSAGE_WITHHELD_NOTICE = "[passage text not shown: it contains instruction-like text, a link or markup; the stored evidence record holds the original]";

/** The same source line the M4.4 fallback prints (kept in step by a test), built from database metadata by stored id. */
function sourceLine(item: BundleItem | undefined, m: CitationMetadata): RenderPart[] {
  const bits: RenderPart[] = [
    { kind: "template", text: "Source: " },
    { kind: "metadata", text: `${m.title} - ${m.publisher}` },
    { kind: "template", text: `. ${item?.tier.label ?? "Source"}; ${item?.geo_level ?? "unknown"} scope; ` },
    { kind: "metadata", text: m.publication_date ? `published ${m.publication_date}` : "publication date not recorded" },
  ];
  const ref = m.reference_url ?? m.citation;
  if (ref) bits.push({ kind: "template", text: "; " }, { kind: "metadata", text: ref });
  if (m.is_synthetic) bits.push({ kind: "template", text: "; SYNTHETIC TEST DOCUMENT, not real evidence" });
  bits.push({ kind: "template", text: "." });
  return bits;
}

export function renderExplanation(input: RenderInput): RenderedExplanation {
  const { bundle, kept } = input;
  const parts: RenderPart[] = [];
  const t = (text: string): void => void parts.push({ kind: "template", text });
  const items = new Map<string, BundleItem>();
  for (const f of bundle.facets) for (const i of f.items) if (!items.has(i.citation_id)) items.set(i.citation_id, i);
  for (const h of bundle.historical_context) if (!items.has(h.citation_id)) items.set(h.citation_id, h);

  const s = bundle.signal;
  const place = [s.region.name, s.region.district && s.region.district !== s.region.name ? s.region.district : null, s.region.state].filter((x): x is string => !!x).join(", ");
  t(`${FALLBACK_OPENING}\n\n`);
  t(`Signal: ${SYNDROME_LABEL[s.syndrome] ?? s.syndrome} reports in `);
  parts.push({ kind: "metadata", text: place });
  t(`, ${s.window.start} to ${s.window.end}. This is an emerging signal requiring verification.\n`);
  t("The statements below were written by a language model from the retrieved passages only. Each was checked by software against those passages (cited ids, exact quotes, numbers, dates and names). The checks do not prove that a statement is correct.\n");

  const thin = bundle.stats.selected_chunks < THIN_MIN_PASSAGES || bundle.stats.facets_covered < THIN_MIN_FACETS;
  if (thin) t(`\nLimited evidence: only ${bundle.stats.selected_chunks} passage(s) from ${bundle.stats.selected_documents} document(s) were selected, so this summary is incomplete.\n`);

  const section = (title: string, points: readonly KeptPoint[]): void => {
    if (points.length === 0) return;
    t(`\n${title}\n`);
    points.forEach((p, n) => {
      t(`${n + 1}. `);
      parts.push({ kind: "model", text: p.text });
      t(`  (cited: ${[...p.citations].sort((a, b) => citationNumber(a) - citationNumber(b)).join(", ")})\n`);
      for (const a of p.anchors) {
        t(`    Quoted from [${a.citation}]: "`);
        parts.push({ kind: "quote", text: a.quote, citation_id: a.citation });
        t('"\n');
      }
    });
  };
  section("Evidence statements (what individual passages say)", kept.filter((p) => p.kind === "evidence_statement" || p.kind === "terminology"));
  section("Model synthesis (written by the model by combining passages; it is not itself evidence)", kept.filter((p) => p.kind === "synthesis" || p.kind === "agreement" || p.kind === "disagreement"));

  if (input.uncertainties.length) {
    t("\nUncertainty (listed by the model)\n");
    for (const u of input.uncertainties) {
      t("- ");
      parts.push({ kind: "model", text: u });
      t("\n");
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
        const cited = [...new Set(p.documents.flatMap((d) => d.citation_ids))].sort((a, b) => citationNumber(a) - citationNumber(b));
        t(cited.length ? ` (${cited.join(", ")})` : "");
      });
      t(".\n");
    }
  }

  if (bundle.gaps.length || input.missing_evidence.length) {
    t("\nMissing evidence\n");
    for (const g of bundle.gaps) {
      t("- ");
      parts.push({ kind: "gap", text: g.message });
      t("\n");
    }
    for (const m of input.missing_evidence) {
      t("- (listed by the model) ");
      parts.push({ kind: "model", text: m });
      t("\n");
    }
  }

  const cited = [...new Set(kept.flatMap((p) => p.citations))].sort((a, b) => citationNumber(a) - citationNumber(b));
  if (cited.length) {
    t("\nCited passages (stored text, with source details from the database)\n");
    for (const id of cited) {
      const passage = input.passages.get(id)!;
      const m = input.resolve(passage.evidence_version_id);
      if (!m) throw new Error(`explanation: no database metadata for evidence version ${passage.evidence_version_id} (${id})`);
      t(`\n[${id}] "`);
      parts.push({ kind: "excerpt", text: scanAnchor(passage.text).length ? PASSAGE_WITHHELD_NOTICE : passage.text, citation_id: id });
      t('"\n    ');
      parts.push(...sourceLine(items.get(id), m));
      t("\n");
    }
  }
  t("\nThis summary only restates retrieved passages and the details of their sources. It is an emerging signal requiring verification by a public-health officer and is not a finding.\n");

  return { text: parts.map((p) => p.text).join(""), parts, thin, cited };
}

/** The text the system itself authors in an explanation (templates and gap messages), with embedded place names and document ids removed. */
export function explanationOwnWording(bundle: EvidenceBundle, parts: readonly RenderPart[]): string[] {
  return ownWording(bundle, parts.filter((p) => p.kind === "template" || p.kind === "gap") as Part[]);
}

export interface RenderCheck {
  name: string;
  ok: boolean;
}

/** Deterministic checks on a rendered explanation, run before it is stored. A failure is a bug in the system, not a model verdict. */
export function checkRendered(bundle: EvidenceBundle, rendered: RenderedExplanation, kept: readonly KeptPoint[], passages: PassageMap): RenderCheck[] {
  const ids = new Set(bundle.citations.map((c) => c.citation_id));
  const quotes = rendered.parts.filter((p) => p.kind === "quote");
  return [
    { name: "opens with the required sentence", ok: rendered.text.startsWith(`${FALLBACK_OPENING}\n`) },
    { name: "every citation id in the text exists in the bundle", ok: [...rendered.text.matchAll(/\[(E\d+)\]/g)].every((m) => ids.has(m[1])) },
    { name: "every excerpt shown is the stored passage text, verbatim (or the withheld notice for a passage with instruction-like text or markup)", ok: rendered.parts.filter((p) => p.kind === "excerpt").every((p) => p.text === PASSAGE_WITHHELD_NOTICE ? scanAnchor(passages.get(p.citation_id!)?.text ?? "").length > 0 : passages.get(p.citation_id!)?.text === p.text) },
    { name: "every quote shown is one of the validated anchors", ok: quotes.length === kept.reduce((n, p) => n + p.anchors.length, 0) && quotes.every((q) => kept.some((p) => p.anchors.some((a) => a.quote === q.text && a.citation === q.citation_id))) },
    { name: "the system's own wording contains no diagnosis, cause, outbreak or treatment language", ok: explanationOwnWording(bundle, rendered.parts).every((x) => !FORBIDDEN_FALLBACK_WORDING.test(x)) },
    { name: "every bundle gap is stated exactly", ok: bundle.gaps.every((g) => rendered.parts.some((p) => p.kind === "gap" && p.text === g.message)) },
  ];
}
