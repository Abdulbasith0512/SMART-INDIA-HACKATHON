// @vitest-environment node
// The human-evaluation export: complete enough for two independent raters, every rating empty, nothing presented as a judgement.
import { describe, expect, it } from "vitest";
import { IDENTITY } from "../bundle/testkit";
import { MockProvider } from "../llm/mock";
import { generateFor } from "./generation";
import { indexJudgments } from "./judgments";
import { CLAIM_COLUMNS, ITEM_COLUMNS, PENDING_HUMAN_EVALUATION, csvCell, reviewClaimsCsv, reviewDataset, reviewItemsCsv, reviewRecord, toCsv } from "./review";
import { runScenario } from "./run";
import { kit, scenario } from "./testkit";

const { base, ctx } = kit();
const judgments = () => indexJudgments(kit().judgments.rows);
const record = async (mock: "valid" | null) => {
  const run = runScenario(base, scenario("E01"), IDENTITY);
  const gen = await generateFor(run, mock ? new MockProvider({ scenario: mock }) : null, ctx.resolve);
  return { run, gen, rec: reviewRecord(run, gen, ctx.resolve, judgments(), "dev") };
};

describe("review record", () => {
  it("carries the scenario, signal, retrieved evidence, bundle, generated explanation, citations, claims, anchors and gaps", async () => {
    const { run, gen, rec } = await record("valid");
    expect(rec.scenario.id).toBe("E01");
    expect(rec.signal.syndrome).toBe(run.inputs.facts.syndrome);
    expect(rec.signal.region.name.length).toBeGreaterThan(0);
    expect(rec.signal.window).toEqual(run.inputs.facts.window);
    expect(rec.retrieved_evidence.length).toBe(run.bundle.facets.reduce((n, f) => n + f.items.length, 0));
    for (const i of rec.retrieved_evidence) {
      expect(i.excerpt.length).toBeGreaterThan(0);
      expect(i.title).not.toBeNull();
      expect(i.publisher).not.toBeNull();
      expect(i.tier_label.length).toBeGreaterThan(0);
    }
    expect(rec.bundle.bundle_hash).toBe(run.bundle.bundle_hash);
    expect(rec.bundle.gaps.length).toBe(run.bundle.gaps.length);
    expect(rec.generated_explanation.shown).toBe("validated_model_explanation");
    expect(rec.generated_explanation.claims.length).toBe(gen.explanation!.points.length);
    for (const c of rec.generated_explanation.claims) {
      expect(c.citations.length).toBeGreaterThan(0);
      expect(c.anchors.length).toBeGreaterThan(0);
    }
    expect(rec.generated_explanation.text.startsWith("Evidence relevant to this emerging signal suggests…")).toBe(true);
  });

  it("every rating field is empty and every reference judgment is labelled a synthetic reference judgment", async () => {
    const { rec } = await record("valid");
    for (const i of rec.retrieved_evidence) {
      expect(i.rating).toEqual({ relevance_0_to_2: null, tier_appropriate: null, notes: null });
      expect(i.reference_judgment.label).toBe("synthetic_reference_judgment");
      expect([0, 1, 2]).toContain(i.reference_judgment.grade);
    }
    for (const c of rec.generated_explanation.claims) expect(c.rating).toEqual({ support: null, clinically_accurate: null, notes: null });
    expect(rec.overall_rating).toEqual({ useful_to_verifier_1_to_5: null, clinical_epidemiological_accuracy_1_to_5: null, notes: null });
  });

  it("when no explanation was validated, it says the deterministic fallback was shown and lists no claims", async () => {
    const { rec } = await record(null);
    expect(rec.generated_explanation.shown).toBe("deterministic_extractive_fallback");
    expect(rec.generated_explanation.claims).toEqual([]);
    expect(rec.generated_explanation.fallback_cause).toBe("provider_failure");
    expect(rec.generated_explanation.text.startsWith("Evidence relevant to this emerging signal suggests…")).toBe(true);
  });
});

describe("review dataset", () => {
  it("is pending, states the rater requirements, and lists everything automated metrics cannot establish", async () => {
    const { rec } = await record("valid");
    const ds = reviewDataset([rec]);
    expect(ds.rating_status).toBe("pending");
    expect(ds.disclaimer).toMatch(/NOT evidence of real-world/);
    expect(ds.rater_requirements).toMatch(/At least two raters/);
    expect(ds.instructions).toMatch(/independently/);
    expect(ds.pending_human_evaluation.map((p) => p.id)).toEqual(["real_corpus_relevance", "clinical_epidemiological_accuracy", "verifier_usefulness", "source_tier_appropriateness", "hindi_odia_quality"]);
    expect(PENDING_HUMAN_EVALUATION.every((p) => p.description.length > 20)).toBe(true);
  });

  it("flattens to CSV with one row per evidence item and per claim, plus empty rater columns", async () => {
    const { rec } = await record("valid");
    const ds = reviewDataset([rec]);
    const items = reviewItemsCsv(ds).trimEnd().split("\n");
    expect(items[0]).toBe(ITEM_COLUMNS.join(","));
    expect(items.length).toBeGreaterThanOrEqual(1 + rec.retrieved_evidence.length);
    const claims = reviewClaimsCsv(ds).trimEnd().split("\n");
    expect(claims[0]).toBe(CLAIM_COLUMNS.join(","));
    expect(claims.length).toBeGreaterThanOrEqual(1 + rec.generated_explanation.claims.length);
  });

  it("contains no secret, key or environment value", async () => {
    const { rec } = await record("valid");
    const text = JSON.stringify(reviewDataset([rec]));
    expect(text).not.toMatch(/GEMINI_API_KEY|SERVICE_ROLE|apikey|api_key\s*[:=]/i);
  });
});

describe("CSV safety", () => {
  it("quotes commas, quotes and newlines and escapes embedded quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("neutralises spreadsheet formula injection from document text", () => {
    for (const bad of ["=SUM(A1:A9)", "+1+1", "-2+3", "@cmd", "\tdata"]) expect(csvCell(bad).replace(/^"/, "")).toMatch(/^'/);
  });

  it("writes null and undefined as empty cells and objects as JSON", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(7)).toBe("7");
    expect(csvCell(false)).toBe("false");
    expect(toCsv(["a", "b"], [{ a: 1, b: null }])).toBe("a,b\n1,\n");
  });
});
