// An INDEPENDENT oracle for what must never be presented. It is written from the stated rules of the evidence layer
// (current documents only, verified sources only, English only, no synthetic evidence in production, local evidence only
// for the signal's own place, no look-ahead, no expired guidance), NOT by calling the production eligibility or ranking code.
// If production ever presents something this oracle forbids, the safety invariants fail and the disagreement is a finding -
// it is never silently averaged away.
import type { CorpusItem } from "../retrieval/corpus";

export interface OracleContext {
  asOf: string;
  /** The signal's own region and its ancestors, with levels. */
  chain: ReadonlyArray<{ id: string; level: string }>;
  profile: "dev" | "production";
}

export type OracleDoc = Pick<CorpusItem, "status" | "trustLevel" | "sourceClass" | "language" | "isSynthetic" | "geoScope" | "geoRegionId" | "publicationDate" | "validFrom" | "validUntil" | "evidenceKind">;

const EXPIRING_KINDS = new Set(["operational_guidance", "case_definition"]);

/** Every hard rule the document breaks for this signal; empty means it may be presented. Sorted for determinism. */
export function ineligibleReasons(d: OracleDoc, ctx: OracleContext): string[] {
  const out: string[] = [];
  if (d.status !== "current") out.push(`status:${d.status}`);
  if (d.sourceClass === "unverified" || d.trustLevel === "unreviewed") out.push("unverified_source");
  if (d.language !== "en") out.push("language_not_english");
  if (d.isSynthetic && ctx.profile === "production") out.push("synthetic_in_production");
  if ((d.geoScope === "state" || d.geoScope === "district") && !ctx.chain.some((r) => r.id === d.geoRegionId && r.level === d.geoScope)) out.push("wrong_geography");
  if (d.publicationDate && d.publicationDate > ctx.asOf) out.push("published_after_as_of");
  if (d.validFrom && d.validFrom > ctx.asOf) out.push("not_yet_valid");
  if (d.validUntil && d.validUntil < ctx.asOf && d.evidenceKind && EXPIRING_KINDS.has(d.evidenceKind)) out.push("expired");
  return out.sort();
}

/** Reasons that make evidence STALE (not in force at the as-of date), as opposed to wrong-place or unverified. */
export const isStaleReason = (r: string): boolean => r.startsWith("status:") || r === "published_after_as_of" || r === "not_yet_valid" || r === "expired";
export const isGeoReason = (r: string): boolean => r === "wrong_geography";
export const isOtherIneligibleReason = (r: string): boolean => r === "unverified_source" || r === "language_not_english" || r === "synthetic_in_production";
