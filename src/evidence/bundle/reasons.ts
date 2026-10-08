// Deterministic "why relevant" reasons. Every reason is built from a fixed template and a fact that already exists in
// the candidate's metadata or its recorded score components. No model, no free text, and no claim that goes beyond
// those facts: a reason says what matched or what the source is, never that the evidence is true or applies to a
// disease.
import type { RankedCandidate } from "../ranking/types";
import { compareCodePoints } from "../retrieval/tokenize";
import { SOURCE_CLASS_TIERS, type QueryFacet } from "../vocab";

export const FACET_LABEL: Record<QueryFacet, string> = {
  verification_guidance: "verification guidance",
  case_definition: "case definition",
  epidemiological_context: "epidemiological context",
  regional_context: "regional context",
};

export const SYNDROME_LABEL: Record<string, string> = {
  acute_diarrhoeal_illness: "acute diarrhoeal illness",
  fever: "fever",
  fever_with_rash: "fever with rash",
  jaundice: "acute jaundice",
  respiratory_illness: "acute respiratory illness",
};

const KIND_REASON: Record<string, (c: RankedCandidate) => string> = {
  operational_guidance: (c) => (c.scoreComponents.temporalFactor.rule === "current_guidance_no_decay" ? "current operational guidance" : "operational guidance"),
  case_definition: () => "case definition document",
  clinical_epidemiology_reference: () => "epidemiological context: reference material, context for a verifier only",
  situation_report: (c) => `situation report published ${c.metadata.publicationDate ?? "on an unknown date"}`,
  surveillance_data: (c) => `surveillance data published ${c.metadata.publicationDate ?? "on an unknown date"}`,
  research: () => "research literature",
};

const MAX_TERMS_LISTED = 8;
const TIERS = SOURCE_CLASS_TIERS.length - 1; // `unverified` is never ranked

export function whyRelevant(c: RankedCandidate, facet: QueryFacet, ctx: { syndrome: string; facetTopics: readonly string[] }): string[] {
  const out: string[] = [];
  const overlap = c.metadata.topics.filter((t) => ctx.facetTopics.includes(t)).sort(compareCodePoints);
  if (overlap.length) out.push(`topic match: ${overlap.join(", ")} (${FACET_LABEL[facet]} facet)`);

  const label = SYNDROME_LABEL[ctx.syndrome] ?? ctx.syndrome;
  if (c.metadata.syndromes.includes(ctx.syndrome)) out.push(`syndrome match: specific to ${label}`);
  else if (c.metadata.syndromes.length === 0) out.push("syndrome match: general document that applies to every syndrome");

  const terms = [...new Set(c.matchedTerms.map((m) => m.term))].sort(compareCodePoints);
  if (terms.length) out.push(`query terms matched: ${terms.slice(0, MAX_TERMS_LISTED).join(", ")}${terms.length > MAX_TERMS_LISTED ? ` (+${terms.length - MAX_TERMS_LISTED} more)` : ""}`);
  out.push(`lexical match strength: ${Math.round(c.scoreComponents.relevance.value * 100)}% of the best match in this facet`);

  const kind = c.metadata.evidenceKind;
  if (kind && KIND_REASON[kind]) out.push(KIND_REASON[kind](c));
  if (facet === "regional_context") out.push("regional context: seasonal or local factors");

  out.push(`geographic applicability: ${c.scoreComponents.geoFactor.reason}`);
  out.push(`source tier: ${c.tierLabel} (tier ${c.scoreComponents.classFactor.tier} of ${TIERS})`);
  out.push(`temporal applicability: ${c.scoreComponents.temporalFactor.reason}`);
  return out;
}
