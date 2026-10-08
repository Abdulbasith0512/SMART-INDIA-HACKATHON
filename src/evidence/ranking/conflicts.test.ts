// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CONTRADICTS_SIGNAL, contradictingDocuments, detectConflicts, type ConflictTag } from "./conflicts";
import type { RankedCandidate } from "./types";

const sel = (itemId: string, canonicalId: string | null, chunk: string, facet = "verification_guidance", publisher = "Synthetic P", sourceClass = "national_government_health_agency"): RankedCandidate =>
  ({ evidenceItemId: itemId, canonicalId, chunkId: chunk, facet, metadata: { publisher, sourceClass } }) as unknown as RankedCandidate;
const tags = (o: Record<string, ConflictTag>): Map<string, ConflictTag> => new Map(Object.entries(o));
const tag = (questionKey: string | null, position: string | null): ConflictTag => ({ questionKey, position });

describe("conflicts come only from curator tags", () => {
  it("reports no conflict when nothing is tagged (never a guess)", () => {
    expect(detectConflicts([sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2")], tags({}))).toEqual([]);
    expect(detectConflicts([sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2")], tags({ a: tag(null, null), b: tag(null, null) }))).toEqual([]);
    expect(detectConflicts([], tags({}))).toEqual([]);
  });

  it("reports a conflict for two selected documents with the same question and different positions", () => {
    const out = detectConflicts(
      [sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2", "regional_context", "Synthetic Q")],
      tags({ a: tag("reporting_deadline", "within_24_hours"), b: tag("reporting_deadline", "within_72_hours") }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ questionKey: "reporting_deadline", basis: "curator_tags" });
    expect(out[0].positions.map((p) => p.position)).toEqual(["within_24_hours", "within_72_hours"]);
    expect(out[0].positions[0].documents[0]).toMatchObject({ canonicalId: "doc-a", publisher: "Synthetic P", chunkIds: ["c1"], facets: ["verification_guidance"] });
    expect(out[0].positions[1].documents[0]).toMatchObject({ canonicalId: "doc-b", facets: ["regional_context"] });
    expect(out[0].note).toMatch(/No disagreement was inferred/);
  });

  it("reports nothing when documents share a question but agree", () => {
    expect(detectConflicts([sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2")], tags({ a: tag("q", "yes"), b: tag("q", "yes") }))).toEqual([]);
  });

  it("reports nothing when only one document of a question is selected, or the other is untagged", () => {
    expect(detectConflicts([sel("a", "doc-a", "c1")], tags({ a: tag("q", "yes"), b: tag("q", "no") }))).toEqual([]);
    expect(detectConflicts([sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2")], tags({ a: tag("q", "yes") }))).toEqual([]);
  });

  it("does not compare different questions", () => {
    expect(detectConflicts([sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2")], tags({ a: tag("q1", "yes"), b: tag("q2", "no") }))).toEqual([]);
  });

  it("counts a document once even when several of its chunks (or facets) are selected", () => {
    const out = detectConflicts(
      [sel("a", "doc-a", "c1"), sel("a", "doc-a", "c2", "regional_context"), sel("b", "doc-b", "c3")],
      tags({ a: tag("q", "yes"), b: tag("q", "no") }),
    );
    const docA = out[0].positions.find((p) => p.position === "yes")!.documents;
    expect(docA).toHaveLength(1);
    expect(docA[0].chunkIds).toEqual(["c1", "c2"]);
    expect(docA[0].facets).toEqual(["regional_context", "verification_guidance"]);
  });

  it("two documents agreeing against a third form one conflict with grouped positions", () => {
    const out = detectConflicts(
      [sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2"), sel("c", "doc-c", "c3")],
      tags({ a: tag("q", "yes"), b: tag("q", "yes"), c: tag("q", "no") }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].positions.map((p) => [p.position, p.documents.map((d) => d.canonicalId)])).toEqual([["no", ["doc-c"]], ["yes", ["doc-a", "doc-b"]]]);
  });

  it("is deterministic and independent of input order; output is sorted", () => {
    const input = [sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2"), sel("c", "doc-c", "c3"), sel("d", "doc-d", "c4")];
    const t = tags({ a: tag("zeta", "p1"), b: tag("zeta", "p2"), c: tag("alpha", "p1"), d: tag("alpha", "p2") });
    const forward = detectConflicts(input, t);
    expect(forward.map((c) => c.questionKey)).toEqual(["alpha", "zeta"]);
    expect(JSON.stringify(detectConflicts([...input].reverse(), t))).toBe(JSON.stringify(forward));
  });

  it("falls back to the row id when a legacy document has no canonical id", () => {
    const out = detectConflicts([sel("row-b", null, "c2"), sel("row-a", null, "c1")], tags({ "row-a": tag("q", "x"), "row-b": tag("q", "y") }));
    expect(out[0].positions[0].documents[0].evidenceItemId).toBe("row-a");
  });

  it("never infers disagreement from similar or opposite-sounding text", () => {
    const a = { ...sel("a", "doc-a", "c1"), text: "must be reported within 24 hours" };
    const b = { ...sel("b", "doc-b", "c2"), text: "must be reported within 72 hours" };
    expect(detectConflicts([a, b] as RankedCandidate[], tags({}))).toEqual([]);
  });
});

describe("evidence a curator marked as contradicting the signal's apparent interpretation", () => {
  it("is surfaced (not suppressed) using the reserved position code", () => {
    expect(CONTRADICTS_SIGNAL).toBe("contradicts_signal_interpretation");
    const out = contradictingDocuments(
      [sel("a", "doc-a", "c1"), sel("b", "doc-b", "c2"), sel("b", "doc-b", "c3")],
      tags({ a: tag("alternative_explanation", "supports"), b: tag("alternative_explanation", CONTRADICTS_SIGNAL) }),
    );
    expect(out).toEqual([{ canonicalId: "doc-b", evidenceItemId: "b", questionKey: "alternative_explanation" }]);
  });

  it("is empty without the reserved tag, however contradictory the text", () => {
    expect(contradictingDocuments([sel("a", "doc-a", "c1")], tags({ a: tag("q", "no") }))).toEqual([]);
    expect(contradictingDocuments([sel("a", "doc-a", "c1")], tags({}))).toEqual([]);
  });
});
