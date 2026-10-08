// The fixed scenario set used by the ranking sensitivity analysis: every detected syndrome in three places
// (a Khordha block, a Ganjam block, and a district in another state), over the committed SYNTHETIC development
// corpus. Reads the corpus from disk, so it is for scripts and tests only (never imported by application code).
import { RETRIEVAL_CONFIG_DEV } from "../retrieval/config";
import { ganjamFacts, makeFacts, otherStateFacts, SYNDROMES, viewFromPrepared } from "../retrieval/testkit";
import type { Scenario } from "./sensitivity";

export function sensitivityScenarios(): Scenario[] {
  const view = viewFromPrepared();
  const places = [["khordha", makeFacts], ["ganjam", ganjamFacts], ["other_state", otherStateFacts]] as const;
  return SYNDROMES.flatMap((syndrome) =>
    places.map(([place, facts]) => ({ id: `${syndrome}@${place}`, facts: facts({ syndrome }), view, retrievalConfig: RETRIEVAL_CONFIG_DEV })),
  );
}
