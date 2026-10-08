// Test helpers for the evaluation harness (not a test file). Builds the authored inputs FRESH from the deterministic generators,
// so tests do not depend on the committed artefacts (a separate test checks that the committed artefacts equal these).
import { loadDevCorpus, type DevCorpus } from "./devcorpus";
import { buildJudgmentsArtefact, loadDocRoles } from "./artifacts";
import { authorScenarioSet } from "./authoring";
import { buildContext, type EvalContext } from "./evaluate";
import type { DocRoles, Judgments, Scenario, ScenarioSet } from "./types";

export interface Kit {
  root: string;
  base: DevCorpus;
  set: ScenarioSet;
  roles: DocRoles;
  judgments: Judgments;
  ctx: EvalContext;
}

let cached: Kit | null = null;
export function kit(): Kit {
  if (cached) return cached;
  const root = process.cwd();
  const base = loadDevCorpus(root);
  const roles = loadDocRoles(root);
  const set = authorScenarioSet(base);
  const judgments = buildJudgmentsArtefact(base, set, roles);
  cached = { root, base, set, roles, judgments, ctx: buildContext(base, set, roles, judgments.rows) };
  return cached;
}

export function scenario(id: string): Scenario {
  const s = kit().set.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

/** A scenario (any split) matching the predicate. */
export function findScenario(pred: (s: Scenario) => boolean): Scenario {
  const s = kit().set.scenarios.find(pred);
  if (!s) throw new Error("no scenario matches");
  return s;
}
