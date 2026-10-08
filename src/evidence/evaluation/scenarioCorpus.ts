// Turning a scenario into the inputs the production pipeline takes: SignalFacts, the (possibly varied) corpus views, the
// retrieval configuration and the as-of date. Pure: nothing here reads a file or a database. The committed development
// corpus itself is loaded by devcorpus.ts (scripts and tests only).
import { hashJson } from "../hash";
import { RETRIEVAL_CONFIG_DEV, RETRIEVAL_CONFIG_V1, type RetrievalConfig } from "../retrieval/config";
import type { CorpusItem, CorpusView } from "../retrieval/corpus";
import { SIGNAL_FACTS_SCHEMA, signalFactsSchema, type SignalFacts } from "../retrieval/signal";
import type { FactsSpec, Scenario } from "./types";

/** Deterministic UUID-shaped id from a label: the same formula the retrieval test kit uses, so region ids line up with the corpus. */
export const deterministicId = (label: string): string => {
  const h = hashJson(label);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const regionId = (code: string): string => deterministicId(`region:${code}`);
export const signalId = (key: string): string => deterministicId(`signal:${key}`);

export function factsOf(spec: FactsSpec, key: string): SignalFacts {
  return signalFactsSchema.parse({
    schema: SIGNAL_FACTS_SCHEMA,
    signal_id: signalId(key),
    syndrome: spec.syndrome,
    region: { id: regionId(spec.region.code), name: spec.region.name, level: spec.region.level },
    ancestors: spec.ancestors.map((a) => ({ id: regionId(a.code), name: a.name, level: a.level })),
    window: spec.window,
    involved_blocks: spec.involved_blocks.map((b) => ({ id: regionId(b.code), name: b.name })),
    spread: spec.spread,
    persistence: spec.persistence,
  });
}

export const scenarioFacts = (s: Scenario): SignalFacts => factsOf(s.facts, s.signal_key ?? s.id);

export interface ScenarioInputs {
  facts: SignalFacts;
  view: CorpusView;
  historicalView: CorpusView;
  retrievalConfig: RetrievalConfig;
  asOfDate: string;
  retrievalProfile: "dev" | "production";
}

export interface CorpusBase {
  view: CorpusView;
  historicalView: CorpusView;
}

function select(items: CorpusItem[], only: readonly string[] | undefined, remove: readonly string[] | undefined): CorpusItem[] {
  return items.filter((i) => (only ? only.includes(i.canonicalId ?? "") : true) && !(remove ?? []).includes(i.canonicalId ?? ""));
}

/** Apply a scenario's declarative variant to the base corpus. Curator conflict tags are corpus metadata, applied to the main view only. */
export function inputsFor(base: CorpusBase, s: Scenario): ScenarioInputs {
  const v = s.variant;
  const tags = v.tags ?? {};
  const view: CorpusView = {
    ...base.view,
    items: select(base.view.items, v.only_docs, v.remove_docs).map((i) => (i.canonicalId && tags[i.canonicalId] ? { ...i, questionKey: tags[i.canonicalId].question_key, position: tags[i.canonicalId].position } : i)),
  };
  const historicalView: CorpusView = { ...base.historicalView, items: select(base.historicalView.items, v.only_docs, v.remove_docs) };
  const facts = scenarioFacts(s);
  return {
    facts,
    view,
    historicalView,
    retrievalConfig: v.retrieval_config === "production" ? RETRIEVAL_CONFIG_V1 : RETRIEVAL_CONFIG_DEV,
    asOfDate: v.as_of_date ?? facts.window.end,
    retrievalProfile: v.retrieval_config,
  };
}

/** Days between two ISO calendar dates (b - a). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
