// The evaluation orchestrator: runs scenarios through the UNMODIFIED production pipeline and gathers everything the artefacts
// report. Pure (no file access): inputs are passed in, results are returned. It changes no production behaviour and feeds nothing back.
import type { MetadataResolver } from "../bundle/fallback";
import { IDENTITY, devResolver } from "../bundle/testkit";
import { sha256Hex } from "../hash";
import { MockProvider, type MockScenario } from "../llm/mock";
import { FIXTURES, NEUTRAL_FIXTURE, independentFindings, runCase, summariseAdversarial, type AdversarialReport, type CaseOutcome } from "./adversarial";
import { aggregateRetrieval, type RetrievalAggregate } from "./aggregate";
import {
  aggregateGeneration, aggregateStale, generateFor, generationFacts, replayFor, staleProbe, storeGeneration,
  type GenerationAggregate, type GenerationFacts, type StaleProbe, type StoredGeneration,
} from "./generation";
import { indexJudgments } from "./judgments";
import { reviewRecord, type ReviewRecord } from "./review";
import { passagesOf, runScenario, type ScenarioRun } from "./run";
import type { CorpusBase } from "./scenarioCorpus";
import { evaluateScenario, type ScenarioEval } from "./scenarioEval";
import { rate, type Rate } from "./stats";
import type { DocRoles, JudgmentRow, Scenario, ScenarioSet, Split } from "./types";

export interface EvalContext {
  base: CorpusBase;
  set: ScenarioSet;
  roles: DocRoles;
  judgments: ReturnType<typeof indexJudgments>;
  resolve: MetadataResolver;
}

export function buildContext(base: CorpusBase, set: ScenarioSet, roles: DocRoles, rows: readonly JudgmentRow[], resolve: MetadataResolver = devResolver()): EvalContext {
  return { base, set, roles, judgments: indexJudgments(rows), resolve };
}

// ------------------------------------------------------------------------------------------------ the scripted provider
/**
 * Which scripted MockProvider answer a scenario receives. Fixed by the scenario id (never by a result), so it is part of the frozen
 * design. It makes the fallback taxonomy (provider failure / schema failure / validator rejection) occur at known rates: the rates
 * reported are properties of THIS SCRIPT, not of any language model.
 */
export const SCRIPT_WEIGHTS: ReadonlyArray<readonly [MockScenario, number]> = [
  ["valid", 13], ["mixed_one_bad", 2], ["mostly_bad", 1], ["malformed_json", 1], ["timeout", 1], ["missing_evidence", 1], ["unsupported_entity", 1],
];
const SCRIPT_TOTAL = SCRIPT_WEIGHTS.reduce((n, [, w]) => n + w, 0);

export function scriptFor(scenarioId: string): MockScenario {
  let n = parseInt(sha256Hex(`m4.6-script|${scenarioId}`).slice(0, 8), 16) % SCRIPT_TOTAL;
  for (const [name, w] of SCRIPT_WEIGHTS) {
    if (n < w) return name;
    n -= w;
  }
  return "valid";
}

// ------------------------------------------------------------------------------------------------ one scenario
export interface GenerationRecord {
  script: MockScenario;
  /** The recorded provider answers; metrics are computed from a replay of exactly these. */
  stored: StoredGeneration;
  facts: GenerationFacts;
  /** Replaying the stored answers reproduced the fresh run's status and output hash. */
  replay_matches: boolean;
  /** Independent structural re-checks of a validated explanation (empty = none violated). */
  structural_findings: string[];
}

export interface ScenarioResult {
  id: string;
  split: Split;
  evaluation: ScenarioEval;
  generation: GenerationRecord;
  stale_probe: StaleProbe | null;
}

export interface SplitRun {
  split: Split;
  results: ScenarioResult[];
  review: ReviewRecord[];
}

export async function evaluateOne(ctx: EvalContext, scenario: Scenario): Promise<{ result: ScenarioResult; review: ReviewRecord; run: ScenarioRun }> {
  const run = runScenario(ctx.base, scenario, IDENTITY);
  const evaluation = evaluateScenario(run, ctx.judgments, ctx.roles);
  const script = scriptFor(scenario.id);
  const fresh = await generateFor(run, new MockProvider({ scenario: script }), ctx.resolve);
  const stored = storeGeneration(scenario.id, fresh);
  const replayed = await replayFor(run, stored, ctx.resolve);
  const passages = passagesOf(run);
  const facts = generationFacts(run, replayed, passages, ctx.resolve, ctx.judgments);
  const generation: GenerationRecord = {
    script, stored, facts,
    replay_matches: replayed.status === fresh.status && replayed.output_hash === fresh.output_hash && replayed.input_hash === fresh.input_hash,
    structural_findings: independentFindings(replayed, NEUTRAL_FIXTURE, run, passages),
  };
  return {
    result: { id: scenario.id, split: scenario.split, evaluation, generation, stale_probe: staleProbe(run) },
    review: reviewRecord(run, replayed, ctx.resolve, ctx.judgments, scenario.split),
    run,
  };
}

export async function runSplit(ctx: EvalContext, split: Split): Promise<SplitRun> {
  const results: ScenarioResult[] = [];
  const review: ReviewRecord[] = [];
  for (const scenario of ctx.set.scenarios.filter((s) => s.split === split)) {
    const one = await evaluateOne(ctx, scenario);
    results.push(one.result);
    review.push(one.review);
  }
  return { split, results, review };
}

// ------------------------------------------------------------------------------------------------ split-level summary
export interface SplitSummary {
  split: Split;
  scenarios: number;
  by_family: Record<string, number>;
  by_category: Record<string, number>;
  retrieval: RetrievalAggregate;
  generation: GenerationAggregate & {
    scripted: { weights: Array<[string, number]>; note: string; by_script: Record<string, { scenarios: number; statuses: Record<string, number>; claims: number; claims_unsupported: number; claims_forbidden: number }> };
    valid_answer_acceptance: Rate;
    replay_fidelity: Rate;
    structural_findings: number;
  };
  stale_citations: ReturnType<typeof aggregateStale>;
}

const count = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

function byScript(gens: readonly GenerationRecord[]): SplitSummary["generation"]["scripted"]["by_script"] {
  const out: SplitSummary["generation"]["scripted"]["by_script"] = {};
  for (const g of gens) {
    const e = (out[g.script] ??= { scenarios: 0, statuses: {}, claims: 0, claims_unsupported: 0, claims_forbidden: 0 });
    e.scenarios += 1;
    e.statuses[g.facts.status] = (e.statuses[g.facts.status] ?? 0) + 1;
    e.claims += g.facts.claims;
    e.claims_unsupported += g.facts.claims_unsupported;
    e.claims_forbidden += g.facts.claims_forbidden;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function summariseSplit(split: Split, results: readonly ScenarioResult[]): SplitSummary {
  const evals = results.map((r) => r.evaluation);
  const gens = results.map((r) => r.generation);
  const askedValid = gens.filter((g) => g.script === "valid" && g.facts.status !== "skipped");
  return {
    split,
    scenarios: results.length,
    by_family: count(evals, (e) => e.family),
    by_category: count(evals, (e) => e.category),
    retrieval: aggregateRetrieval(evals, `m4.6|${split}`),
    generation: {
      ...aggregateGeneration(gens.map((g) => g.facts), "scripted_mock_provider"),
      scripted: { weights: SCRIPT_WEIGHTS.map(([n, w]) => [n, w]), note: "Provider answers are scripted by scenario id. Fallback and rejection rates therefore describe the script, not a language model.", by_script: byScript(gens) },
      valid_answer_acceptance: rate(askedValid.filter((g) => g.facts.status === "validated").length, askedValid.length),
      replay_fidelity: rate(gens.filter((g) => g.replay_matches).length, gens.length),
      structural_findings: gens.reduce((n, g) => n + g.structural_findings.length, 0),
    },
    stale_citations: aggregateStale(results.map((r) => r.stale_probe)),
  };
}

// ------------------------------------------------------------------------------------------------ adversarial
export interface AdversarialRun {
  report: AdversarialReport;
  outcomes: CaseOutcome[];
  fixtures: Array<{ id: string; category: string; mock: string; planted: boolean }>;
}

/** Every fixture against every scenario's bundle (both splits): adversarial behaviour is a property of the validators, not of a split. */
export async function runAdversarial(ctx: EvalContext): Promise<AdversarialRun> {
  const outcomes: CaseOutcome[] = [];
  for (const scenario of ctx.set.scenarios) {
    const run = runScenario(ctx.base, scenario, IDENTITY);
    for (const fixture of FIXTURES) outcomes.push(await runCase(fixture, run, ctx.resolve));
  }
  return { report: summariseAdversarial(outcomes), outcomes, fixtures: FIXTURES.map((f) => ({ id: f.id, category: f.category, mock: f.mock, planted: f.planted !== undefined })) };
}
