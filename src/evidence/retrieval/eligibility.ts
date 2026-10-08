// Metadata eligibility: FILTER, not RANK.
//
// A document is either eligible to compete for a facet or it is not, for reasons that are all recorded. This
// module never produces a weight or a preference: how strongly eligible evidence is PRESENTED (source-class,
// geography and age factors, deduplication, diversity) belongs to M4.3. Every check is binary and independent;
// ALL failing reasons are returned (sorted) so an exclusion log is complete and deterministic.
//
//   status        only the configured statuses (M4.2: `current`). Quarantined/draft/withdrawn/superseded/historical never compete.
//   trust         trust level at least `reviewed`; source classes such as `unverified` never compete.
//   provenance    synthetic documents compete only where the configuration explicitly allows it.
//   content       the document must have a current version with chunks, and that version's last link check must not have failed.
//   language      only languages the query vocabulary has terms for (cross-lingual retrieval is not provided).
//   topic         the document's topics must overlap the facet's controlled topics.
//   syndrome      a document that names syndromes must name the signal's; a document naming none is general.
//   geography     global / regional / national documents are eligible everywhere; a state or district document is
//                 eligible ONLY if its region is the signal's own state or district. Different-state/district
//                 evidence is excluded, never treated as local, and nothing is inferred from names.
//   temporal      binary rules only: no look-ahead past the as-of date, not-yet-valid excluded, and expired
//                 guidance / case definitions excluded. (Age-based weighting is M4.3.)
import type { EligibilityPolicy } from "./config";
import type { CorpusItem } from "./corpus";
import { compareCodePoints } from "./tokenize";

export type ExclusionReason =
  | "status_not_eligible" | "trust_below_minimum" | "source_class_excluded" | "synthetic_not_allowed" | "no_current_version" | "no_chunks"
  | "source_check_failed" | "language_not_queryable" | "topic_mismatch" | "syndrome_mismatch" | "geo_scope_missing" | "geo_scope_mismatch"
  | "published_after_as_of" | "not_yet_valid" | "validity_ended";

export type GeoMatch = "global" | "regional" | "national" | "state" | "district";

export interface EligibilityContext {
  syndrome: string;
  /** The signal's own region and its ancestors, with their levels. */
  regionChain: ReadonlyArray<{ id: string; level: string }>;
  asOfDate: string;
}

export type Eligibility = { eligible: true; geoMatch: GeoMatch } | { eligible: false; reasons: ExclusionReason[] };

const TRUST_RANK: Record<string, number> = { unreviewed: 0, reviewed: 1, trusted: 2 };

export function evaluateEligibility(item: CorpusItem, facetTopics: readonly string[], ctx: EligibilityContext, policy: EligibilityPolicy): Eligibility {
  const reasons = new Set<ExclusionReason>();

  if (!policy.statuses.includes(item.status)) reasons.add("status_not_eligible");
  if ((TRUST_RANK[item.trustLevel] ?? -1) < TRUST_RANK[policy.minTrust]) reasons.add("trust_below_minimum");
  if (policy.excludedSourceClasses.includes(item.sourceClass)) reasons.add("source_class_excluded");
  if (item.isSynthetic && !policy.allowSynthetic) reasons.add("synthetic_not_allowed");

  if (!item.version) reasons.add("no_current_version");
  else if (policy.excludedFetchStatuses.includes(item.version.fetchStatus)) reasons.add("source_check_failed");
  if (item.version && item.chunks.length === 0 && policy.statuses.includes(item.status)) reasons.add("no_chunks");

  if (!item.language || !policy.languages.includes(item.language)) reasons.add("language_not_queryable");
  if (!item.topics.some((t) => facetTopics.includes(t))) reasons.add("topic_mismatch");
  if (item.syndromes.length > 0 && !item.syndromes.includes(ctx.syndrome)) reasons.add("syndrome_mismatch");

  let geoMatch: GeoMatch | null = null;
  switch (item.geoScope) {
    case "global":
    case "regional":
    case "national":
      geoMatch = item.geoScope;
      break;
    case "state":
    case "district": {
      const hit = item.geoRegionId !== null && ctx.regionChain.some((r) => r.id === item.geoRegionId && r.level === item.geoScope);
      if (hit) geoMatch = item.geoScope;
      else reasons.add("geo_scope_mismatch");
      break;
    }
    default:
      reasons.add("geo_scope_missing");
  }

  if (policy.temporal.noLookAhead) {
    if (item.publicationDate && item.publicationDate > ctx.asOfDate) reasons.add("published_after_as_of");
    if (item.validFrom && item.validFrom > ctx.asOfDate) reasons.add("not_yet_valid");
  }
  if (item.validUntil && item.validUntil < ctx.asOfDate && item.evidenceKind && policy.temporal.expiryKinds.includes(item.evidenceKind)) reasons.add("validity_ended");

  if (reasons.size === 0 && geoMatch) return { eligible: true, geoMatch };
  return { eligible: false, reasons: [...reasons].sort(compareCodePoints) as ExclusionReason[] };
}
