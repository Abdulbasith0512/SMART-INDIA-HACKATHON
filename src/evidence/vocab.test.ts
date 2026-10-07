// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_TOPICS, QUERY_FACETS, QUERY_VOCAB_VERSION, RETRIEVABLE_SOURCE_CLASSES, SOURCE_CLASS_TIERS, SYNDROME_QUERY,
} from "./vocab";

const DETECTED_SYNDROMES = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"];

describe("evidence vocabulary", () => {
  it("is versioned and has unique topic codes", () => {
    expect(QUERY_VOCAB_VERSION).toMatch(/^query-vocab\/\d+\.\d+\.\d+$/);
    expect(new Set(EVIDENCE_TOPICS).size).toBe(EVIDENCE_TOPICS.length);
  });

  it("covers every syndrome the detector analyses, with every facet, using only known topics", () => {
    expect(Object.keys(SYNDROME_QUERY).sort()).toEqual([...DETECTED_SYNDROMES].sort());
    for (const [syndrome, spec] of Object.entries(SYNDROME_QUERY)) {
      expect(spec.terms.length, syndrome).toBeGreaterThanOrEqual(3);
      for (const facet of QUERY_FACETS) {
        expect(spec.topics[facet].length, `${syndrome}/${facet}`).toBeGreaterThan(0);
        for (const t of spec.topics[facet]) expect(EVIDENCE_TOPICS as readonly string[]).toContain(t);
      }
    }
  });

  it("query terms describe syndromes and condition families, never a diagnosis or an outbreak declaration", () => {
    const all = Object.values(SYNDROME_QUERY).flatMap((s) => s.terms).join(" ");
    expect(all).not.toMatch(/\bconfirmed\b|\bdiagnos|\bis cholera\b|\btreat(ment)?\b|\bprescri/i);
  });

  it("source tiers are ordered with 'unverified' last and never retrievable", () => {
    expect(SOURCE_CLASS_TIERS[0]).toBe("intergovernmental_health_authority");
    expect(SOURCE_CLASS_TIERS[SOURCE_CLASS_TIERS.length - 1]).toBe("unverified");
    expect(RETRIEVABLE_SOURCE_CLASSES).not.toContain("unverified");
    expect(RETRIEVABLE_SOURCE_CLASSES).toHaveLength(SOURCE_CLASS_TIERS.length - 1);
  });
});
