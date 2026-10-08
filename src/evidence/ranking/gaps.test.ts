// @vitest-environment node
import { describe, expect, it } from "vitest";
import { QUERY_FACETS, type QueryFacet } from "../vocab";
import { makeFacts, otherStateFacts } from "../retrieval/testkit";
import { computeGaps, regionLabel } from "./gaps";
import { RANKING_CONFIG_V1 } from "./policy";
import type { Gap, GapCode, RankedCandidate, RankedFacet } from "./types";

interface Spec {
  facet?: QueryFacet;
  scope?: string;
  kind?: string | null;
  synthetic?: boolean;
  temporal?: number;
}
const cand = (s: Spec = {}): RankedCandidate =>
  ({
    facet: s.facet ?? "verification_guidance",
    metadata: { evidenceKind: s.kind === undefined ? "operational_guidance" : s.kind, isSynthetic: s.synthetic ?? false },
    scoreComponents: { geoFactor: { evidenceScope: s.scope ?? "national" }, temporalFactor: { value: s.temporal ?? 1 } },
  }) as unknown as RankedCandidate;
const facets = (...bySelected: Partial<Record<QueryFacet, Spec[]>>[]): RankedFacet[] => {
  const merged: Partial<Record<QueryFacet, Spec[]>> = Object.assign({}, ...bySelected);
  return QUERY_FACETS.map((facet) => ({
    facet, selected: (merged[facet] ?? []).map((s) => cand({ ...s, facet })), excluded: [],
    stats: { retrieved: (merged[facet] ?? []).length, rankable: 0, afterFloor: 0, afterDedup: 0, selected: (merged[facet] ?? []).length, normalisedBy: 1 },
  }));
};
const gaps = (f: RankedFacet[], facts = makeFacts(), contradicting: Array<{ canonicalId: string | null; evidenceItemId: string }> = []): Gap[] =>
  computeGaps({ facets: f, facts, cfg: RANKING_CONFIG_V1, contradicting });
const codes = (g: Gap[]): GapCode[] => g.map((x) => x.code);

const FULL = facets({
  verification_guidance: [{ scope: "district" }],
  case_definition: [{ kind: "case_definition", scope: "global" }],
  epidemiological_context: [{ kind: "clinical_epidemiology_reference", scope: "global" }],
  regional_context: [{ scope: "state" }],
});

describe("gaps", () => {
  it("reports none for full, local, current, real, non-contradicting coverage", () => {
    expect(gaps(FULL)).toEqual([]);
  });

  it("no eligible evidence at all: says so, and every facet, local and guidance gap follows", () => {
    const g = gaps(facets());
    expect(codes(g)).toEqual(["no_eligible_evidence", "facet_not_covered", "facet_not_covered", "facet_not_covered", "facet_not_covered", "missing_local_evidence", "no_current_guidance"]);
    expect(g[0].message).toBe("no eligible evidence was found for this signal");
  });

  it("facet coverage: one gap per uncovered facet, in facet order, naming the facet", () => {
    const g = gaps(facets({ verification_guidance: [{ scope: "district" }], regional_context: [{ scope: "state" }] }));
    expect(g.filter((x) => x.code === "facet_not_covered").map((x) => [x.facet, x.message])).toEqual([
      ["case_definition", "no eligible evidence for the case definition facet"],
      ["epidemiological_context", "no eligible evidence for the epidemiological context facet"],
    ]);
    expect(codes(g)).not.toContain("no_eligible_evidence");
  });

  it("missing local evidence uses the exact planned wording and the signal's own place", () => {
    const national = facets({ verification_guidance: [{ scope: "national" }], case_definition: [{ kind: "case_definition", scope: "global" }], epidemiological_context: [{ scope: "regional" }], regional_context: [{ scope: "national" }] });
    const g = gaps(national);
    expect(g.find((x) => x.code === "missing_local_evidence")!.message).toBe("no state-level / district-level evidence for Khordha, Odisha");
    expect(gaps(national, otherStateFacts()).find((x) => x.code === "missing_local_evidence")!.message).toBe("no state-level / district-level evidence for Elsewhere District, Elsewhere State");
    expect(regionLabel(makeFacts())).toBe("Khordha, Odisha");
  });

  it("state-level OR district-level evidence is enough to avoid the local gap", () => {
    for (const scope of ["state", "district"]) {
      expect(codes(gaps(facets({ ...Object.fromEntries(QUERY_FACETS.map((f) => [f, [{ scope: "national", kind: f === "verification_guidance" ? "operational_guidance" : "case_definition" }]])), regional_context: [{ scope, kind: "operational_guidance" }] }))), scope).not.toContain("missing_local_evidence");
    }
  });

  it("no current guidance: absent when no operational guidance is selected (case definitions do not count)", () => {
    const noGuidance = facets({ verification_guidance: [{ kind: "research", scope: "district" }], case_definition: [{ kind: "case_definition", scope: "state" }], epidemiological_context: [{ kind: "clinical_epidemiology_reference" }], regional_context: [{ kind: "situation_report", scope: "state" }] });
    expect(gaps(noGuidance).find((x) => x.code === "no_current_guidance")!.message).toBe("no current operational guidance among the selected evidence");
    expect(codes(gaps(FULL))).not.toContain("no_current_guidance");
  });

  it("all evidence too old: fires only when every selected time-sensitive item is in the oldest bucket", () => {
    const old = facets({ ...Object.fromEntries(QUERY_FACETS.map((f) => [f, [{ kind: "operational_guidance", scope: "state" }]])), regional_context: [{ kind: "situation_report", scope: "state", temporal: 0.3 }, { kind: "surveillance_data", scope: "state", temporal: 0.3 }] });
    expect(gaps(old).find((x) => x.code === "all_evidence_old")!.message).toBe("all selected situation reports and surveillance data are older than one year");
    const mixed = facets({ ...Object.fromEntries(QUERY_FACETS.map((f) => [f, [{ kind: "operational_guidance", scope: "state" }]])), regional_context: [{ kind: "situation_report", scope: "state", temporal: 0.3 }, { kind: "situation_report", scope: "state", temporal: 0.6 }] });
    expect(codes(gaps(mixed))).not.toContain("all_evidence_old");
    expect(codes(gaps(FULL))).not.toContain("all_evidence_old"); // no time-sensitive evidence selected: nothing can be called old
  });

  it("only synthetic evidence: fires when everything selected is synthetic, not when any is real", () => {
    const synth = facets(...QUERY_FACETS.map((f) => ({ [f]: [{ scope: "state", synthetic: true }] })));
    expect(gaps(synth).find((x) => x.code === "only_synthetic_evidence")!.message).toBe("all selected evidence is synthetic test data");
    const mixed = facets(...QUERY_FACETS.map((f, i) => ({ [f]: [{ scope: "state", synthetic: i !== 0 }] })));
    expect(codes(gaps(mixed))).not.toContain("only_synthetic_evidence");
    expect(codes(gaps(facets()))).not.toContain("only_synthetic_evidence"); // nothing selected is not "only synthetic"
  });

  it("contradicting evidence: surfaced by name when a curator tagged it, never invented", () => {
    const g = gaps(FULL, makeFacts(), [{ canonicalId: "doc-z", evidenceItemId: "z" }]);
    expect(g.find((x) => x.code === "contradicting_evidence")!.message).toBe("curator-tagged evidence contradicts the apparent interpretation of the signal: doc-z");
    expect(codes(gaps(FULL))).not.toContain("contradicting_evidence");
  });

  it("is deterministic, in a fixed code order, and message text is template-built", () => {
    const a = gaps(facets());
    expect(JSON.stringify(gaps(facets()))).toBe(JSON.stringify(a));
    const order: GapCode[] = ["no_eligible_evidence", "facet_not_covered", "missing_local_evidence", "no_current_guidance", "all_evidence_old", "only_synthetic_evidence", "contradicting_evidence"];
    const idx = codes(a).map((c) => order.indexOf(c));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });

  it("a gap is an absence: it carries no evidence text", () => {
    for (const g of gaps(facets())) expect(JSON.stringify(g)).not.toMatch(/"text"/);
  });
});
