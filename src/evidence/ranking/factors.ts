// The four components of the rank score, each a pure function that records WHY it gave its value.
//   rank_score = normalised_relevance x class_factor x geo_factor x temporal_factor
// A function may also decline a candidate (hard exclusion) instead of returning a weight: wrong place and
// out-of-force evidence are never down-weighted, they are excluded with a machine-readable reason.
import type { CandidateMetadata } from "../retrieval/retrieve";
import type { SignalFacts } from "../retrieval/signal";
import { SOURCE_CLASS_TIERS, type SourceClass } from "../vocab";
import { GEO_SPECIFICITY, roundRank, TIER_LABELS, type GeoLevel, type RankingConfig } from "./policy";

// ---------------------------------------------------------------- relevance
export interface Normalisation {
  values: number[];
  /** The facet's best BM25 score (the divisor). 0 when there is nothing positive to divide by. */
  maximum: number;
}

/**
 * Max-normalisation within one facet's candidate set: value = bm25 / max(bm25), so the best match is exactly 1 and
 * ties stay tied. It is RELATIVE: a facet whose best match is weak still has a top relevance of 1, which is why the
 * raw BM25 score is always kept next to it. Never NaN: empty input gives no values; a zero or non-finite maximum
 * gives all zeros; a negative or non-finite score counts as 0.
 */
export function normaliseRelevance(scores: readonly number[]): Normalisation {
  const clean = scores.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const maximum = clean.reduce((m, s) => (s > m ? s : m), 0);
  if (!(maximum > 0)) return { values: clean.map(() => 0), maximum: 0 };
  return { values: clean.map((s) => roundRank(Math.min(1, s / maximum))), maximum };
}

// ---------------------------------------------------------------- source class
export interface ClassComponent {
  value: number;
  sourceClass: SourceClass;
  /** 1 = highest presentation tier. */
  tier: number;
  tierLabel: string;
  basis: string;
}

export type ClassAssessment = { ok: true; component: ClassComponent } | { ok: false; reason: "source_class_not_rankable"; detail: string };

export function assessClass(sourceClass: string, cfg: RankingConfig): ClassAssessment {
  const idx = (SOURCE_CLASS_TIERS as readonly string[]).indexOf(sourceClass);
  const value = idx >= 0 ? cfg.classFactor.table[sourceClass as SourceClass] : undefined;
  if (idx < 0 || value === null || value === undefined) {
    return { ok: false, reason: "source_class_not_rankable", detail: `source class "${sourceClass}" has no presentation tier and is never ranked` };
  }
  return {
    ok: true,
    component: {
      value,
      sourceClass: sourceClass as SourceClass,
      tier: idx + 1,
      tierLabel: TIER_LABELS[sourceClass as SourceClass],
      basis: "ordinal presentation-priority tier; not a probability, not a truth score, not confidence in correctness",
    },
  };
}

// ---------------------------------------------------------------- geography
export interface GeoComponent {
  value: number;
  evidenceScope: GeoLevel;
  signalGeography: { region: string; district: string | null; state: string | null };
  reason: string;
}

export type GeoAssessment = { ok: true; component: GeoComponent } | { ok: false; reason: "geographic_ineligible"; detail: string };

export function signalGeography(facts: SignalFacts): GeoComponent["signalGeography"] {
  const level = (l: string) => facts.ancestors.find((a) => a.level === l)?.name ?? (facts.region.level === l ? facts.region.name : null);
  return { region: facts.region.name, district: level("district"), state: level("state") };
}

export function assessGeography(meta: Pick<CandidateMetadata, "geoScope" | "geoRegionId">, facts: SignalFacts, cfg: RankingConfig): GeoAssessment {
  const geo = signalGeography(facts);
  const scope = meta.geoScope;
  if (scope === "global" || scope === "regional" || scope === "national") {
    const reason: Record<string, string> = {
      national: "national scope: applies across the country, less specific than the signal's own state or district",
      regional: "regional scope: applies to a multi-country region, less specific than national",
      global: "global scope: applies everywhere, least specific",
    };
    return { ok: true, component: { value: cfg.geoFactor.table[scope], evidenceScope: scope, signalGeography: geo, reason: reason[scope] } };
  }
  if (scope === "state" || scope === "district") {
    const chain = [{ id: facts.region.id, level: facts.region.level }, ...facts.ancestors.map((a) => ({ id: a.id, level: a.level }))];
    const own = meta.geoRegionId !== null && chain.some((r) => r.id === meta.geoRegionId && r.level === scope);
    if (own) {
      return {
        ok: true,
        component: { value: cfg.geoFactor.table[scope], evidenceScope: scope, signalGeography: geo, reason: `${scope} scope: evidence is for the signal's own ${scope}` },
      };
    }
    return { ok: false, reason: "geographic_ineligible", detail: `${scope}-scoped evidence is not for the signal's own ${scope} (${scope === "state" ? geo.state : geo.district ?? geo.region})` };
  }
  return { ok: false, reason: "geographic_ineligible", detail: "evidence has no geographic scope" };
}

export const geoSpecificity = (scope: string | null): number => (scope ? GEO_SPECIFICITY[scope] ?? 0 : 0);

// ---------------------------------------------------------------- time
export type TemporalExclusion = "withdrawn" | "superseded" | "historical" | "not_current" | "look_ahead" | "not_yet_valid" | "expired" | "unknown_evidence_kind";

export interface TemporalComponent {
  value: number;
  rule: string;
  /** Days from the age basis date to the as-of date (age-decay kinds only). */
  ageDays: number | null;
  reason: string;
}

export type TemporalAssessment = { ok: true; component: TemporalComponent } | { ok: false; reason: TemporalExclusion; detail: string };

const DAY_MS = 86_400_000;
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10)) - Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10))) / DAY_MS);
}

/**
 * The approved temporal rules, applied exactly:
 *  hard exclusions - not current (withdrawn / superseded / historical / other), published after the as-of date
 *    (no look-ahead), not yet valid, and expired guidance or case definitions;
 *  guidance and case definitions: factor 1.0, no age decay; clinical/epidemiology references: no decay;
 *  situation reports and surveillance data: <= 90 days 1.0, <= 365 days 0.6, older 0.3;
 *  research: neutral (1.0).
 * M4.2 already filters these hard cases; they are re-checked here so ranking can never be fed an out-of-force item.
 */
export function assessTemporal(
  meta: Pick<CandidateMetadata, "status" | "evidenceKind" | "publicationDate" | "validFrom" | "validUntil">,
  ctx: { asOfDate: string },
  cfg: RankingConfig,
  opts: { allowHistoricalStatuses?: boolean } = {},
): TemporalAssessment {
  const t = cfg.temporalFactor;
  const fail = (reason: TemporalExclusion, detail: string): TemporalAssessment => ({ ok: false, reason, detail });
  if (meta.status !== "current") {
    // Historical context is a separate section that deliberately holds superseded / historical documents.
    if (!(opts.allowHistoricalStatuses && (meta.status === "superseded" || meta.status === "historical"))) {
      const known = ["withdrawn", "superseded", "historical"] as const;
      const code = (known as readonly string[]).includes(meta.status) ? (meta.status as TemporalExclusion) : "not_current";
      return fail(code, `status is ${meta.status}; only current evidence is ranked in the main list`);
    }
  }
  if (meta.publicationDate && meta.publicationDate > ctx.asOfDate) return fail("look_ahead", `published ${meta.publicationDate}, after the as-of date ${ctx.asOfDate}`);
  if (meta.validFrom && meta.validFrom > ctx.asOfDate) return fail("not_yet_valid", `valid from ${meta.validFrom}, after the as-of date ${ctx.asOfDate}`);
  const kind = meta.evidenceKind;
  if (!kind) return fail("unknown_evidence_kind", "evidence kind is missing, so no temporal rule can be applied");
  // An old edition's validity has naturally ended; for historical context that is the point, not a disqualifier.
  const inHistoricalSection = opts.allowHistoricalStatuses === true && meta.status !== "current";
  if (!inHistoricalSection && meta.validUntil && meta.validUntil < ctx.asOfDate && t.expiryKinds.includes(kind)) {
    return fail("expired", `${kind} was valid only until ${meta.validUntil}, before the as-of date ${ctx.asOfDate}`);
  }
  if (inHistoricalSection) {
    return { ok: true, component: { value: 1, rule: "historical_context_neutral", ageDays: null, reason: `status ${meta.status}: shown only in the historical context section; no recency weighting` } };
  }
  if (t.noDecayKinds.includes(kind)) {
    return {
      ok: true,
      component: {
        value: 1,
        rule: kind === "clinical_epidemiology_reference" ? "reference_no_decay" : "current_guidance_no_decay",
        ageDays: null,
        reason: kind === "clinical_epidemiology_reference" ? "clinical/epidemiology reference: no age decay" : `${kind} is current: factor 1.0, no age decay`,
      },
    };
  }
  if (t.neutralKinds.includes(kind)) return { ok: true, component: { value: 1, rule: "research_neutral", ageDays: null, reason: "research: neutral temporal factor" } };
  if (t.ageDecayKinds.includes(kind)) {
    const basis = meta.publicationDate ?? meta.validFrom;
    if (!basis) {
      const oldest = t.ageBuckets[t.ageBuckets.length - 1].factor;
      return { ok: true, component: { value: oldest, rule: "age_unknown_oldest_bucket", ageDays: null, reason: `${kind} has no publication or valid-from date: the oldest bucket applies` } };
    }
    const age = daysBetween(basis, ctx.asOfDate);
    const bucket = t.ageBuckets.find((b) => b.maxDays === null || age <= b.maxDays)!;
    return {
      ok: true,
      component: { value: bucket.factor, rule: bucket.maxDays === null ? "age_over_one_year" : `age_within_${bucket.maxDays}_days`, ageDays: age, reason: `${kind} is ${age} days old at the as-of date` },
    };
  }
  return fail("unknown_evidence_kind", `no temporal rule exists for evidence kind "${kind}"`);
}
