// Run ONE scenario through the unmodified production pipeline: SignalFacts -> M4.2 retrieval (current + historical pass)
// -> M4.3 ranking -> M4.4 bundle, over the scenario's in-memory corpus. This module only CALLS production code; nothing in the
// evaluation harness changes retrieval, ranking, bundling or generation behaviour, and no result is fed back into any of them.
import { buildBundle, type SignalIdentity } from "../bundle/build";
import type { EvidenceBundle } from "../bundle/types";
import { historicalRetrievalConfig } from "../ranking/pipeline";
import { rankEvidence } from "../ranking/rank";
import type { RankedEvidence } from "../ranking/types";
import { retrieveFromCorpus, type RetrievalResult } from "../retrieval/retrieve";
import type { Passage, PassageMap } from "../llm/types";
import { inputsFor, type CorpusBase, type ScenarioInputs } from "./scenarioCorpus";
import type { Scenario } from "./types";

export const RETRIEVED_AT = "2026-01-01T00:00:00.000Z";

export interface ScenarioRun {
  scenario: Scenario;
  inputs: ScenarioInputs;
  retrieval: RetrievalResult;
  historical: RetrievalResult;
  ranking: RankedEvidence;
  bundle: EvidenceBundle;
}

export function runScenario(base: CorpusBase, scenario: Scenario, identity: SignalIdentity): ScenarioRun {
  const inputs = inputsFor(base, scenario);
  const options = { asOfDate: inputs.asOfDate };
  const retrieval = retrieveFromCorpus(inputs.view, inputs.facts, inputs.retrievalConfig, options);
  const historical = retrieveFromCorpus(inputs.historicalView, inputs.facts, historicalRetrievalConfig(inputs.retrievalConfig), options);
  const ranking = rankEvidence({ facts: inputs.facts, retrieval, historical, view: inputs.view });
  const bundle = buildBundle({ facts: inputs.facts, identity, retrieval, ranking, retrievedAt: RETRIEVED_AT });
  return { scenario, inputs, retrieval, historical, ranking, bundle };
}

/** The passages of a bundle as the database path would resolve them: text by the bundle's stored chunk ids. */
export function passagesOf(run: Pick<ScenarioRun, "bundle" | "inputs">): PassageMap {
  const text = new Map<string, string>();
  for (const v of [run.inputs.view, run.inputs.historicalView]) for (const i of v.items) for (const c of i.chunks) text.set(c.id, c.text);
  const out = new Map<string, Passage>();
  for (const c of run.bundle.citations) {
    const t = text.get(c.chunk_id);
    if (t === undefined) throw new Error(`scenario ${run.bundle.signal.candidate_id}: no text for ${c.citation_id}`);
    out.set(c.citation_id, { citation_id: c.citation_id, evidence_version_id: c.evidence_version_id, chunk_id: c.chunk_id, text: t, facets: c.appears_in.map((a) => a.facet) });
  }
  return out;
}
