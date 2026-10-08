// The real-corpus boundary. M4.6 adds NO real document, scrapes nothing and makes no real-world quality claim. What it provides is
// the contract by which a future curator can supply a real corpus and expert judgments to this same harness, and the gate that
// refuses to treat anything as a real-corpus evaluation until the human prerequisites exist:
//
//   - a curated corpus whose every document has a verified source and a verified licence,
//   - relevance judgments by at least MIN_RATERS independent public-health raters,
//   - inter-rater agreement computed BEFORE adjudication and above the pre-registered floor,
//   - adjudicated judgments frozen (hashed) before any system result is seen,
//   - no synthetic document in the corpus.
//
// This file validates a package description (an attestation plus the rater grades). It does not load documents or run retrieval.
import { z } from "zod";
import { hashJson } from "../hash";
import { kappaOf, round6 } from "./stats";

export const REAL_CORPUS_SCHEMA = "m4-real-corpus-package/1";
export const REAL_CORPUS_GATE = { min_raters: 2, min_kappa: 0.61, min_judged_items: 200 } as const;

const FACETS = ["verification_guidance", "case_definition", "epidemiological_context", "regional_context"] as const;

export const expertJudgmentSchema = z
  .object({
    scenario: z.string(),
    facet: z.enum(FACETS),
    canonical_id: z.string(),
    chunk_ordinal: z.number().int().min(0),
    /** Independent grades 0/1/2 by each rater, keyed by rater id (before adjudication). */
    rater_grades: z.record(z.string(), z.union([z.literal(0), z.literal(1), z.literal(2)])),
    adjudicated_grade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

export const realCorpusPackageSchema = z
  .object({
    schema: z.literal(REAL_CORPUS_SCHEMA),
    corpus: z
      .object({
        corpus_id: z.string().min(3),
        corpus_hash: z.string().regex(/^[0-9a-f]{64}$/),
        curator: z.string().min(2),
        documents: z.number().int().min(1),
        synthetic_documents: z.number().int().min(0),
        licence_verified_documents: z.number().int().min(0),
        source_verified_documents: z.number().int().min(0),
      })
      .strict(),
    raters: z.array(z.object({ id: z.string().min(1), qualification: z.string().min(3) }).strict()),
    judgments: z.array(expertJudgmentSchema),
    judgments_frozen_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();

export type RealCorpusPackage = z.infer<typeof realCorpusPackageSchema>;

export interface RealCorpusReadiness {
  ready: boolean;
  blockers: string[];
  raters: number;
  judged_items: number;
  pairwise_kappa: Array<{ raters: [string, string]; kappa: number | null; items: number }>;
  min_pairwise_kappa: number | null;
  judgments_hash: string;
  gate: typeof REAL_CORPUS_GATE;
}

/** The judgments hash a curator must record before any system result is seen: over the adjudicated grades only. */
export const adjudicatedJudgmentsHash = (pkg: RealCorpusPackage): string =>
  hashJson(pkg.judgments.map((j) => [j.scenario, j.facet, j.canonical_id, j.chunk_ordinal, j.adjudicated_grade]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));

export function assessRealCorpus(raw: unknown): RealCorpusReadiness {
  const parsed = realCorpusPackageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ready: false, blockers: [`package is not valid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`], raters: 0, judged_items: 0,
      pairwise_kappa: [], min_pairwise_kappa: null, judgments_hash: hashJson(null), gate: REAL_CORPUS_GATE,
    };
  }
  const pkg = parsed.data;
  const c = pkg.corpus;
  const blockers: string[] = [];
  if (c.synthetic_documents > 0) blockers.push(`${c.synthetic_documents} synthetic document(s) in a corpus presented as real`);
  if (c.licence_verified_documents < c.documents) blockers.push(`licence verified for ${c.licence_verified_documents} of ${c.documents} documents`);
  if (c.source_verified_documents < c.documents) blockers.push(`source verified for ${c.source_verified_documents} of ${c.documents} documents`);
  if (pkg.raters.length < REAL_CORPUS_GATE.min_raters) blockers.push(`${pkg.raters.length} rater(s) declared (needs ${REAL_CORPUS_GATE.min_raters})`);
  if (pkg.judgments.length < REAL_CORPUS_GATE.min_judged_items) blockers.push(`${pkg.judgments.length} judged items (needs ${REAL_CORPUS_GATE.min_judged_items})`);

  const raterIds = pkg.raters.map((r) => r.id);
  const pairwise: RealCorpusReadiness["pairwise_kappa"] = [];
  for (let i = 0; i < raterIds.length; i += 1) {
    for (let j = i + 1; j < raterIds.length; j += 1) {
      const both = pkg.judgments.filter((x) => x.rater_grades[raterIds[i]] !== undefined && x.rater_grades[raterIds[j]] !== undefined);
      pairwise.push({ raters: [raterIds[i], raterIds[j]], kappa: kappaOf<number>(both.map((x) => x.rater_grades[raterIds[i]]), both.map((x) => x.rater_grades[raterIds[j]])), items: both.length });
    }
  }
  const kappas = pairwise.map((p) => p.kappa);
  if (pairwise.length === 0 || kappas.some((k) => k === null)) blockers.push("inter-rater agreement cannot be computed");
  const defined = kappas.filter((k): k is number => k !== null);
  const minKappa = defined.length ? round6(Math.min(...defined)) : null;
  if (minKappa !== null && minKappa < REAL_CORPUS_GATE.min_kappa) blockers.push(`minimum pairwise kappa ${minKappa} is below ${REAL_CORPUS_GATE.min_kappa}`);

  const hash = adjudicatedJudgmentsHash(pkg);
  if (pkg.judgments_frozen_hash === null) blockers.push("adjudicated judgments were not frozen (no judgments_frozen_hash)");
  else if (pkg.judgments_frozen_hash !== hash) blockers.push("adjudicated judgments differ from the frozen hash");
  const undeclared = new Set(pkg.judgments.flatMap((j) => Object.keys(j.rater_grades)).filter((id) => !raterIds.includes(id)));
  if (undeclared.size) blockers.push(`grades from undeclared rater(s): ${[...undeclared].join(", ")}`);

  return { ready: blockers.length === 0, blockers, raters: pkg.raters.length, judged_items: pkg.judgments.length, pairwise_kappa: pairwise, min_pairwise_kappa: minKappa, judgments_hash: hash, gate: REAL_CORPUS_GATE };
}
