// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { EvidenceDb, Row } from "../ingest/ingest";
import { REGION_COLUMNS, SIGNAL_COLUMNS, istDate, istInclusiveEndDate, loadSignalFacts, signalFactsFromCandidate, signalFactsSchema, type RegionRow } from "./signal";
import { makeFacts, REGION, uid } from "./testkit";

const regions = new Map<string, RegionRow>(
  [
    { id: REGION.country, name: "India", region_type: "country", parent_region_id: null },
    { id: REGION.state, name: "Odisha", region_type: "state", parent_region_id: REGION.country },
    { id: REGION.khordha, name: "Khordha", region_type: "district", parent_region_id: REGION.state },
    { id: REGION.balianta, name: "Balianta", region_type: "block", parent_region_id: REGION.khordha },
    { id: REGION.jatni, name: "Jatni", region_type: "block", parent_region_id: REGION.khordha },
  ].map((r) => [r.id, r]),
);

/** A stored M3 candidate row as the detector writes it, INCLUDING fields retrieval must never carry along. */
function candidateRow(over: Row = {}): Row {
  return {
    id: uid("signal:real"), syndrome: "acute_diarrhoeal_illness", region_id: REGION.balianta,
    time_window_start: "2025-08-31T18:30:00+00:00", time_window_end: "2025-09-07T18:30:00+00:00",
    score_components: { deviation: 0.9, persistence: 0.8, volume: 0.4, geographic: 1, sourceMix: 0.5, quality: 0.9, involvedBlocks: 1, blocksInDistrict: 4, priority: "high", weights: { deviation: 0.35 }, note: "x" },
    evidence: { detector_version: "v1", involved_blocks: [{ id: REGION.balianta, name: "Balianta" }], peak: { observed: 17, expected: 4.2, ratio: 4, p_value: 0.00001, window_days: 5 }, n_alarm_days: 4 },
    // fields below are NOT in SIGNAL_COLUMNS; a careless caller might pass the whole row
    observed_value: 17, baseline_value: 4.2, deviation: 5.1, signal_score: 81, sample_count: 17, confidence: 0.74, explanation: "Emerging signal requiring verification: 17 reports in Balianta",
    created_by: uid("user:x"), review_note: "free text a reviewer wrote",
    ...over,
  };
}

describe("SignalFacts projection from a stored M3 candidate", () => {
  it("keeps only the allowed facts", () => {
    const f = signalFactsFromCandidate(candidateRow(), regions);
    expect(Object.keys(f).sort()).toEqual(["ancestors", "involved_blocks", "persistence", "region", "schema", "signal_id", "spread", "syndrome", "window"]);
    expect(f.region).toEqual({ id: REGION.balianta, name: "Balianta", level: "block" });
    expect(f.ancestors.map((a) => [a.name, a.level])).toEqual([["Khordha", "district"], ["Odisha", "state"], ["India", "country"]]);
    expect(f.syndrome).toBe("acute_diarrhoeal_illness");
    expect(f.spread).toBe("single_block");
    expect(f.persistence).toBe("sustained");
  });

  it("carries no counts, scores, explanation, reviewer text, user ids or other candidate fields", () => {
    const facts = signalFactsFromCandidate(candidateRow(), regions);
    const text = JSON.stringify(facts);
    for (const leak of ["Emerging signal", "requiring verification", "free text a reviewer wrote", "p_value", "observed", "weights", "created_by", uid("user:x")]) {
      expect(text, leak).not.toContain(leak);
    }
    // Structural check: the facts contain no numbers at all, so no count, score or p-value can be present.
    const numbers: unknown[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "number") numbers.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(facts);
    expect(numbers).toEqual([]);
  });

  it("converts the stored window to inclusive India Standard Time dates", () => {
    const f = signalFactsFromCandidate(candidateRow(), regions);
    expect(f.window).toEqual({ start: "2025-09-01", end: "2025-09-07" });
    expect(istDate("2025-08-31T18:30:00+00:00")).toBe("2025-09-01");
    expect(istDate("2025-09-01T18:29:59+00:00")).toBe("2025-09-01");
    expect(istDate("2025-09-01T18:30:00+00:00")).toBe("2025-09-02");
    expect(istInclusiveEndDate("2025-09-07T18:30:00+00:00")).toBe("2025-09-07"); // exclusive midnight of the 8th
    expect(istInclusiveEndDate("2025-09-07T09:00:00+00:00")).toBe("2025-09-07"); // not on a boundary
    expect(() => istDate("not a date")).toThrow(RangeError);
  });

  it("classifies a multi-block district signal from the score components", () => {
    const f = signalFactsFromCandidate(
      candidateRow({
        region_id: REGION.khordha,
        score_components: { involvedBlocks: 2, blocksInDistrict: 4, persistence: 0.5 },
        evidence: { involved_blocks: [{ id: REGION.jatni, name: "Jatni" }, { id: REGION.balianta, name: "Balianta" }] },
      }),
      regions,
    );
    expect(f.region.level).toBe("district");
    expect(f.involved_blocks.map((b) => b.name)).toEqual(["Balianta", "Jatni"]); // sorted
    expect(f.spread).toBe("district_wide"); // 2 of 4 blocks reaches the documented 0.5 share
    expect(f.persistence).toBe("emerging");
  });

  it("degrades to 'unknown' rather than guessing when components are missing or malformed", () => {
    const f = signalFactsFromCandidate(candidateRow({ region_id: REGION.khordha, score_components: "garbage", evidence: null }), regions);
    expect(f.spread).toBe("unknown");
    expect(f.persistence).toBe("unknown");
    expect(f.involved_blocks).toEqual([]);
    expect(signalFactsFromCandidate(candidateRow({ score_components: { persistence: Number.NaN, involvedBlocks: "x" }, evidence: { involved_blocks: [{ id: 1 }, null, "x"] } }), regions).persistence).toBe("unknown");
  });

  it("throws on a missing region or an unsupported syndrome instead of fabricating one", () => {
    expect(() => signalFactsFromCandidate(candidateRow({ region_id: uid("region:nowhere") }), regions)).toThrow(/missing from the region lookup/);
    expect(() => signalFactsFromCandidate(candidateRow({ syndrome: "other" }), regions)).toThrow();
    expect(() => signalFactsFromCandidate(candidateRow({ syndrome: "unknown" }), regions)).toThrow();
    expect(() => signalFactsFromCandidate(candidateRow({ region_id: null }), regions)).toThrow();
  });
});

describe("SignalFacts schema is strict (privacy by construction)", () => {
  const ok = makeFacts();

  it("accepts the reference facts", () => expect(signalFactsSchema.safeParse(ok).success).toBe(true));

  it.each([
    ["patient_name", "A. Person"], ["phone", "+91 90000 00000"], ["email", "a@b.invalid"], ["latitude", 20.27], ["longitude", 85.84],
    ["address", "12 Some Street"], ["reports", [{ id: "r1" }]], ["observed", 17], ["sample_count", 17], ["explanation", "free text"], ["notes", "x"],
    ["raw_report_ids", ["r1"]], ["deidentified_rows", [1, 2]],
  ])("rejects an extra top-level field: %s", (key, value) => {
    expect(signalFactsSchema.safeParse({ ...ok, [key]: value }).success).toBe(false);
  });

  it("rejects extra fields at every nested level", () => {
    expect(signalFactsSchema.safeParse({ ...ok, region: { ...ok.region, population: 1000 } }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, ancestors: [{ ...ok.ancestors[0], code: "X" }] }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, window: { ...ok.window, hours: 12 } }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, involved_blocks: [{ ...ok.involved_blocks[0], cases: 3 }] }).success).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(signalFactsSchema.safeParse({ ...ok, schema: "signal-facts/0" }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, signal_id: "not-a-uuid" }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, window: { start: "2025-09-08", end: "2025-09-01" } }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, window: { start: "2025-09-01T00:00:00Z", end: "2025-09-07" } }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, spread: "everywhere" }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, region: { ...ok.region, name: "" } }).success).toBe(false);
    expect(signalFactsSchema.safeParse({ ...ok, region: { ...ok.region, name: "x".repeat(121) } }).success).toBe(false);
  });
});

describe("loadSignalFacts reads only what it needs", () => {
  function recordingDb(tables: Record<string, Row[]>): { db: EvidenceDb; calls: Array<{ table: string; columns: readonly string[] | undefined; match: Row | undefined }> } {
    const calls: Array<{ table: string; columns: readonly string[] | undefined; match: Row | undefined }> = [];
    const db: EvidenceDb = {
      async select(table, match, columns) {
        calls.push({ table, columns, match });
        const rows = tables[table] ?? [];
        const m = match ?? {};
        return rows.filter((r) => Object.entries(m).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))).map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r));
      },
      async insert() {
        throw new Error("retrieval must never write");
      },
      async update() {
        throw new Error("retrieval must never write");
      },
    };
    return { db, calls };
  }

  it("selects the named candidate columns and the region columns, from those two tables only", async () => {
    const { db, calls } = recordingDb({ signal_candidates: [candidateRow()], regions: [...regions.values()] as unknown as Row[] });
    const f = await loadSignalFacts(db, uid("signal:real"));
    expect(f?.region.name).toBe("Balianta");
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(["signal_candidates", "regions"]));
    expect(calls[0].columns).toEqual([...SIGNAL_COLUMNS]);
    for (const c of calls.filter((x) => x.table === "regions")) expect(c.columns).toEqual([...REGION_COLUMNS]);
    // the free-text and count columns are never requested
    for (const banned of ["explanation", "observed_value", "baseline_value", "sample_count", "review_note", "signal_score", "created_by"]) {
      expect(calls[0].columns).not.toContain(banned);
    }
  });

  it("returns null for an unknown signal and never writes", async () => {
    const { db } = recordingDb({ signal_candidates: [], regions: [] });
    expect(await loadSignalFacts(db, uid("signal:none"))).toBeNull();
  });
});
