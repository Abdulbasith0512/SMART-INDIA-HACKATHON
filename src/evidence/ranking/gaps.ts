// Evidence gaps: explicit, deterministic statements of what the selected evidence does NOT cover. A gap is an
// absence or a limitation; it is never filled from model knowledge and never invents evidence. Messages are built
// from fixed templates and codes, not generated text.
import { compareCodePoints } from "../retrieval/tokenize";
import type { SignalFacts } from "../retrieval/signal";
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import { signalGeography } from "./factors";
import type { RankingConfig } from "./policy";
import type { Gap, RankedFacet } from "./types";

const FACET_LABEL: Record<QueryFacet, string> = {
  verification_guidance: "verification guidance",
  case_definition: "case definition",
  epidemiological_context: "epidemiological context",
  regional_context: "regional context",
};

export function regionLabel(facts: SignalFacts): string {
  const g = signalGeography(facts);
  return [g.district ?? g.region, g.state].filter((x, i, a): x is string => !!x && a.indexOf(x) === i).join(", ");
}

export function computeGaps(args: {
  facets: readonly RankedFacet[];
  facts: SignalFacts;
  cfg: RankingConfig;
  contradicting: ReadonlyArray<{ canonicalId: string | null; evidenceItemId: string }>;
}): Gap[] {
  const { facets, facts, cfg, contradicting } = args;
  const selected = facets.flatMap((f) => f.selected);
  const gaps: Gap[] = [];

  if (selected.length === 0) {
    gaps.push({ code: "no_eligible_evidence", scope: "signal", facet: null, message: "no eligible evidence was found for this signal", basis: { candidatesRetrieved: facets.reduce((n, f) => n + f.stats.retrieved, 0) } });
  }

  for (const facet of QUERY_FACETS) {
    const f = facets.find((x) => x.facet === facet);
    if (!f || f.selected.length === 0) {
      gaps.push({
        code: "facet_not_covered", scope: "facet", facet,
        message: `no eligible evidence for the ${FACET_LABEL[facet]} facet`,
        basis: { retrieved: f?.stats.retrieved ?? 0, rankable: f?.stats.rankable ?? 0, afterFloor: f?.stats.afterFloor ?? 0 },
      });
    }
  }

  const local = selected.filter((c) => c.scoreComponents.geoFactor.evidenceScope === "state" || c.scoreComponents.geoFactor.evidenceScope === "district");
  if (local.length === 0) {
    gaps.push({
      code: "missing_local_evidence", scope: "signal", facet: null,
      message: `no state-level / district-level evidence for ${regionLabel(facts)}`,
      basis: { signalGeography: signalGeography(facts), selectedByScope: countBy(selected.map((c) => c.scoreComponents.geoFactor.evidenceScope)) },
    });
  }

  if (!selected.some((c) => c.metadata.evidenceKind === "operational_guidance")) {
    gaps.push({ code: "no_current_guidance", scope: "signal", facet: null, message: "no current operational guidance among the selected evidence", basis: { selectedByKind: countBy(selected.map((c) => c.metadata.evidenceKind ?? "unknown")) } });
  }

  const oldest = cfg.temporalFactor.ageBuckets[cfg.temporalFactor.ageBuckets.length - 1].factor;
  const timeSensitive = selected.filter((c) => c.metadata.evidenceKind !== null && cfg.temporalFactor.ageDecayKinds.includes(c.metadata.evidenceKind));
  if (timeSensitive.length > 0 && timeSensitive.every((c) => c.scoreComponents.temporalFactor.value === oldest)) {
    gaps.push({
      code: "all_evidence_old", scope: "signal", facet: null,
      message: "all selected situation reports and surveillance data are older than one year",
      basis: { timeSensitiveSelected: timeSensitive.length, oldestBucketFactor: oldest },
    });
  }

  if (selected.length > 0 && selected.every((c) => c.metadata.isSynthetic)) {
    gaps.push({ code: "only_synthetic_evidence", scope: "signal", facet: null, message: "all selected evidence is synthetic test data", basis: { selected: selected.length } });
  }

  if (contradicting.length > 0) {
    gaps.push({
      code: "contradicting_evidence", scope: "signal", facet: null,
      message: `curator-tagged evidence contradicts the apparent interpretation of the signal: ${contradicting.map((d) => d.canonicalId ?? d.evidenceItemId).join(", ")}`,
      basis: { documents: contradicting.map((d) => d.canonicalId ?? d.evidenceItemId), tag: "contradicts_signal_interpretation (curator-authored)" },
    });
  }
  return gaps;
}

function countBy(xs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of [...xs].sort(compareCodePoints)) out[x] = (out[x] ?? 0) + 1;
  return out;
}
