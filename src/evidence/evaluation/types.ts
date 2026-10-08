// M4.6 evaluation harness - shared types and schemas.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. The development corpus is SYNTHETIC and its reference judgments are authored
// from the same controlled vocabulary the pipeline uses, so the results below demonstrate pipeline correctness,
// deterministic behaviour, regression detection and that the metrics are implemented correctly. They are NOT evidence of
// real-world retrieval quality, clinical accuracy or public-health usefulness, and must never be described as such.
import { z } from "zod";
import { QUERY_FACETS, type QueryFacet } from "../vocab";

export const EVAL_VERSION = "m4-eval/1.0.0";
export const SCENARIO_SCHEMA = "m4-eval-scenarios/1";
export const JUDGMENT_SCHEMA = "m4-eval-judgments/1";
export const DOC_ROLES_SCHEMA = "m4-eval-doc-roles/1";
export const RESULTS_SCHEMA = "m4-eval-results/1";
export const MANIFEST_SCHEMA = "m4-eval-manifest/1";

/** Every judgment in this milestone is a synthetic reference judgment authored by the project. It is not an expert judgment. */
export const JUDGMENT_LABEL = "synthetic_reference_judgment" as const;

export const DISCLAIMER =
  "Synthetic corpus and synthetic reference judgments authored from the same controlled vocabulary as the pipeline. These results demonstrate pipeline " +
  "correctness, deterministic behaviour, regression detection and metric implementation. They are NOT evidence of real-world retrieval quality, clinical " +
  "accuracy or public-health usefulness.";

export const SPLITS = ["dev", "test"] as const;
export type Split = (typeof SPLITS)[number];

export const SYNDROMES = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"] as const;
export type Syndrome = (typeof SYNDROMES)[number];

/** Relevance grades: 0 irrelevant, 1 partially relevant, 2 highly relevant. */
export type Grade = 0 | 1 | 2;

export const FACETS: readonly QueryFacet[] = QUERY_FACETS;

// ------------------------------------------------------------------------------------------------- scenario schema
const code = z.string().regex(/^[A-Z0-9-]{3,40}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const regionSpecSchema = z.object({ code, name: z.string().min(1).max(80), level: z.enum(["country", "state", "district", "block", "locality"]) }).strict();

/** The signal characteristics a scenario presents to the pipeline (the retrieval pipeline's SignalFacts, with region ids derived from codes). */
export const factsSpecSchema = z
  .object({
    syndrome: z.enum(SYNDROMES),
    region: regionSpecSchema,
    ancestors: z.array(regionSpecSchema).max(5),
    window: z.object({ start: isoDate, end: isoDate }).strict(),
    involved_blocks: z.array(z.object({ code, name: z.string().min(1).max(80) }).strict()).max(60),
    spread: z.enum(["single_block", "multi_block", "district_wide", "unknown"]),
    persistence: z.enum(["emerging", "sustained", "unknown"]),
  })
  .strict();

/** A declarative, deterministic change to the development corpus for one scenario (so "no evidence" and "sparse" situations are reproducible). */
export const variantSchema = z
  .object({
    only_docs: z.array(z.string()).optional(),
    remove_docs: z.array(z.string()).optional(),
    tags: z.record(z.string(), z.object({ question_key: z.string(), position: z.string() }).strict()).optional(),
    retrieval_config: z.enum(["dev", "production"]).default("dev"),
    as_of_date: isoDate.optional(),
  })
  .strict();

export const expectationSchema = z
  .object({
    /** No relevant, eligible evidence exists: nothing may be selected, the gap must be explicit, and no explanation may be generated. */
    abstain: z.boolean(),
    gap_codes_include: z.array(z.string()).default([]),
    gap_codes_exclude: z.array(z.string()).default([]),
    /** Canonical ids that must NOT appear in the final selection (hard negatives for this scenario). */
    must_not_select: z.array(z.string()).default([]),
    /** Soft expectation: documents that SHOULD NOT be selected (distractors, redundant copies). A quality finding if violated, not a safety invariant. */
    should_not_select: z.array(z.string()).default([]),
    conflicts: z.number().int().min(0).optional(),
    historical_context: z.enum(["none", "present", "any"]).default("any"),
    facets_empty: z.array(z.enum(["verification_guidance", "case_definition", "epidemiological_context", "regional_context"])).default([]),
  })
  .strict();

export const scenarioSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9-]{1,20}$/),
    family: z.enum(["m3_derived", "edge_case"]),
    category: z.string().min(2).max(60),
    split: z.enum(SPLITS),
    description: z.string().min(5).max(300),
    origin: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    /** The scenario's signal id is derived from this key (default: the scenario id). */
    signal_key: z.string().optional(),
    facts: factsSpecSchema,
    variant: variantSchema,
    expected: expectationSchema,
  })
  .strict();

export const scenarioSetSchema = z
  .object({
    artefact: z.literal("m4-6-scenario-set"),
    schema: z.literal(SCENARIO_SCHEMA),
    version: z.string(),
    disclaimer: z.string(),
    split_rule: z.string(),
    categories: z.array(z.string()),
    scenarios: z.array(scenarioSchema).min(1),
  })
  .strict();

export type FactsSpec = z.infer<typeof factsSpecSchema>;
export type VariantSpec = z.infer<typeof variantSchema>;
export type Expectation = z.infer<typeof expectationSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioSet = z.infer<typeof scenarioSetSchema>;

// ------------------------------------------------------------------------------------------------- judgments
export const docRoleSchema = z
  .object({
    /** Hand-authored facet relevance of the document's content for a signal it applies to (0/1/2). Missing facets are 0. */
    facets: z.record(z.enum(["verification_guidance", "case_definition", "epidemiological_context", "regional_context"]), z.union([z.literal(1), z.literal(2)])).default({}),
    /** irrelevant_distractor: keyword-stuffed or off-topic; redundant_copy: same content as another document; out_of_scope_language. */
    role: z.enum(["relevant", "irrelevant_distractor", "redundant_copy", "out_of_scope_language"]).default("relevant"),
    redundant_copy_of: z.string().optional(),
    justification: z.string().min(5),
  })
  .strict();

export const docRolesSchema = z
  .object({ artefact: z.literal("m4-6-doc-roles"), schema: z.literal(DOC_ROLES_SCHEMA), label: z.literal(JUDGMENT_LABEL), authored_by: z.string(), note: z.string(), roles: z.record(z.string(), docRoleSchema) })
  .strict();
export type DocRole = z.infer<typeof docRoleSchema>;
export type DocRoles = z.infer<typeof docRolesSchema>;

export const judgmentRowSchema = z
  .object({
    scenario: z.string(),
    facet: z.enum(["verification_guidance", "case_definition", "epidemiological_context", "regional_context"]),
    canonical_id: z.string(),
    chunk_ordinal: z.number().int().min(0),
    grade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    /** Why a grade-0 row is listed: a document whose CONTENT is relevant but which must not be presented (stale, wrong place, ...), or a distractor. */
    ineligible_reason: z.string().optional(),
    rule: z.string(),
    justification: z.string(),
  })
  .strict();

export const judgmentsSchema = z
  .object({
    artefact: z.literal("m4-6-judgments"),
    schema: z.literal(JUDGMENT_SCHEMA),
    label: z.literal(JUDGMENT_LABEL),
    disclaimer: z.string(),
    convention: z.string(),
    doc_roles_hash: z.string(),
    scenario_set_hash: z.string(),
    rows: z.array(judgmentRowSchema),
  })
  .strict();
export type JudgmentRow = z.infer<typeof judgmentRowSchema>;
export type Judgments = z.infer<typeof judgmentsSchema>;

/** A stable chunk reference that survives re-ingestion: the document's canonical id and the chunk's ordinal. */
export const chunkKey = (canonicalId: string, ordinal: number): string => `${canonicalId}#${ordinal}`;
