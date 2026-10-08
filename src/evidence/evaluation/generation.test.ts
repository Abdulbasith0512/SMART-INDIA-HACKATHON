// @vitest-environment node
// Generation evaluation: stored-output replay, the fallback taxonomy, validator metrics with explicit denominators (failed and
// abstained generations included), and stale-citation detection.
import { describe, expect, it } from "vitest";
import { IDENTITY } from "../bundle/testkit";
import { MockProvider, type MockScenario } from "../llm/mock";
import { ProviderError } from "../llm/types";
import {
  ReplayProvider, aggregateGeneration, aggregateStale, detectStaleCitations, fallbackCause, generateFor, generationFacts, mutateItem, replayFor, staleProbe, storeGeneration,
  type StoredGeneration,
} from "./generation";
import { runScenario } from "./run";
import { kit, findScenario, scenario } from "./testkit";
import { passagesOf } from "./run";
import { indexJudgments } from "./judgments";

const { base, ctx } = kit();
const e01 = () => runScenario(base, scenario("E01"), IDENTITY);
const judgments = () => indexJudgments(kit().judgments.rows);
const SCRIPTS: MockScenario[] = ["valid", "mixed_one_bad", "mostly_bad", "malformed_json", "timeout", "unsupported_entity", "fabricated_citation", "missing_evidence"];

describe("stored-output replay", () => {
  it("replays the recorded answers through the real pipeline and reproduces status, hashes and attempts", async () => {
    const run = e01();
    for (const script of SCRIPTS) {
      const fresh = await generateFor(run, new MockProvider({ scenario: script }), ctx.resolve);
      const stored = storeGeneration("E01", fresh);
      const replayed = await replayFor(run, stored, ctx.resolve);
      expect(replayed.status, script).toBe(fresh.status);
      expect(replayed.output_hash, script).toBe(fresh.output_hash);
      expect(replayed.input_hash, script).toBe(fresh.input_hash);
      expect(replayed.attempts.length, script).toBe(fresh.attempts.length);
      expect(replayed.attempts.map((a) => a.raw_sha256), script).toEqual(fresh.attempts.map((a) => a.raw_sha256));
    }
  });

  it("never calls a model: it serves exactly the stored attempts and refuses to invent more", async () => {
    const stored: StoredGeneration = {
      scenario: "X", provider: "mock", model: "mock-1", model_version: null, prompt_version: "p", prompt_hash: "h", input_hash: null, skipped_reason: null, status: "rejected", output_hash: null,
      attempts: [{ kind: "text", text: "first" }, { kind: "error", error_kind: "timeout" }],
    };
    const p = new ReplayProvider(stored);
    expect((await p.generate()).text).toBe("first");
    await expect(p.generate()).rejects.toBeInstanceOf(ProviderError);
    await expect(p.generate()).rejects.toThrow(/made only 2 attempt/);
    expect(p.id).toBe("mock");
  });

  it("stored records carry the provider, model, prompt version and hashes", async () => {
    const fresh = await generateFor(e01(), new MockProvider({ scenario: "valid" }), ctx.resolve);
    const s = storeGeneration("E01", fresh);
    expect(s.provider).toBe("mock");
    expect(s.model).toBe("mock-1");
    expect(s.prompt_version).toBe("grounded-explanation/1.0.0");
    expect(s.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.attempts.length).toBeGreaterThan(0);
  });
});

describe("failed generations are separated, not hidden", () => {
  it("classifies each outcome: none / provider_failure / schema_failure / validator_rejection / fallback_extraction", async () => {
    const run = e01();
    const cause = async (s: MockScenario | null) => fallbackCause(await generateFor(run, s ? new MockProvider({ scenario: s }) : null, ctx.resolve));
    expect(await cause("valid")).toBe("none");
    expect(await cause("timeout")).toBe("provider_failure");
    expect(await cause(null)).toBe("provider_failure");
    expect(await cause("malformed_json")).toBe("schema_failure");
    expect(await cause("mostly_bad")).toBe("validator_rejection");
  });

  it("a bundle with no evidence is skipped (no model call) and counted as fallback extraction", async () => {
    const abstain = findScenario((s) => s.expected.abstain);
    const run = runScenario(base, abstain, IDENTITY);
    const r = await generateFor(run, new MockProvider({ scenario: "valid" }), ctx.resolve);
    expect(r.status).toBe("skipped");
    expect(r.attempts).toEqual([]);
    expect(fallbackCause(r)).toBe("fallback_extraction");
    expect(r.explanation).toBeNull();
  });

  it("a rejected generation still contributes its claims to the metrics (they are not hidden by the fallback)", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "fabricated_citation" }), ctx.resolve);
    expect(r.status).toBe("rejected");
    const f = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(f.status).toBe("rejected");
    expect(f.claims).toBeGreaterThan(0);
    expect(f.citations_existing).toBeLessThan(f.citations_listed);
    expect(f.claims_hallucinated).toBeGreaterThan(0);
    // a fabricated id written only in the claim text (not in its citation list) still stops the claim counting as fully anchored
    expect(f.claims_fully_anchored).toBeLessThan(f.claims);
    expect(f.validated_claims).toBe(0);
    expect(f.attempts.total).toBe(2);
    expect(f.attempts.validator_rejection).toBe(2);
  });

  it("a transport failure has no claims and is counted as a provider error attempt", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "timeout" }), ctx.resolve);
    const f = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(f.claims).toBe(0);
    expect(f.attempts.provider_error).toBeGreaterThan(0);
    expect(f.fallback_cause).toBe("provider_failure");
  });
});

describe("validator metrics", () => {
  it("a valid answer: every citation exists, every anchor is verbatim, every claim is complete and the opening is present", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "valid" }), ctx.resolve);
    const f = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(f.status).toBe("validated");
    expect(f.claims).toBeGreaterThan(0);
    expect(f.citations_existing).toBe(f.citations_listed);
    expect(f.anchors_verbatim).toBe(f.anchors_listed);
    expect(f.claims_fully_anchored).toBe(f.claims);
    expect(f.claims_unsupported).toBe(0);
    expect(f.opens_with_required_sentence).toBe(true);
    expect(f.metadata_cited_passages_correct).toBe(f.metadata_cited_passages);
    expect(f.metadata_cited_passages).toBeGreaterThan(0);
    expect(f.facets_with_cited).toBeGreaterThan(0);
    expect(f.facets_with_cited).toBeLessThanOrEqual(f.facets_with_selected);
  });

  it("aggregates with explicit denominators and never reports factual consistency", async () => {
    const run = e01();
    const facts = [];
    for (const s of ["valid", "mostly_bad", "timeout"] as MockScenario[]) {
      const r = await generateFor(run, new MockProvider({ scenario: s }), ctx.resolve);
      facts.push(generationFacts(run, r, passagesOf(run), ctx.resolve, judgments()));
    }
    const a = aggregateGeneration(facts, "scripted_mock_provider");
    expect(a.scenarios).toBe(3);
    expect(a.final_status.validated).toBe(1);
    expect(a.final_status.rejected).toBe(1);
    expect(a.final_status.unavailable).toBe(1);
    expect(a.fallback.fallback_rate).toMatchObject({ k: 2, n: 3 });
    expect(a.fallback.by_cause).toMatchObject({ none: 1, validator_rejection: 1, provider_failure: 1 });
    expect(a.validator.unsupported_claim_rate.n).toBe(a.validator.claims_produced);
    expect(a.validator.structural_groundedness.k + a.validator.unsupported_claim_rate.k).toBe(a.validator.claims_produced);
    expect(a.factual_consistency.status).toBe("not_measured");
    expect(a.caveat).toMatch(/not a measure of any language model/);
  });

  it("produces null, not NaN, when nothing could be measured", () => {
    const a = aggregateGeneration([], "none");
    for (const r of Object.values(a.validator)) {
      if (typeof r === "object" && r !== null) expect((r as { value: number | null }).value).toBeNull();
    }
    expect(a.fallback.fallback_rate.value).toBeNull();
  });
});

describe("stale-citation detection", () => {
  it("flags nothing on an unchanged corpus", () => {
    const run = e01();
    expect(detectStaleCitations(run.bundle, run.inputs.view)).toEqual([]);
  });

  it("flags every citation of a document that was superseded, withdrawn or changed, and only those", () => {
    const run = e01();
    const target = run.bundle.citations.find((c) => c.section === "main")!.evidence_item_id;
    const expected = run.bundle.citations.filter((c) => c.section === "main" && c.evidence_item_id === target).map((c) => c.citation_id).sort();
    expect(expected.length).toBeGreaterThan(0);
    for (const kind of ["superseded", "withdrawn", "content_changed"] as const) {
      const flagged = detectStaleCitations(run.bundle, mutateItem(run.inputs.view, target, kind)).sort();
      expect(flagged, kind).toEqual(expected);
    }
  });

  it("a probe reports full recall and no false positives, and does not exist for a bundle without citations", () => {
    const p = staleProbe(e01())!;
    expect(p.detected).toBe(p.truth);
    expect(p.false_positives).toBe(0);
    expect(p.control_false_positives).toBe(0);
    const abstain = runScenario(base, findScenario((s) => s.expected.abstain), IDENTITY);
    expect(staleProbe(abstain)).toBeNull();
  });

  it("aggregates recall with its denominator and ignores scenarios with nothing to probe", () => {
    const p = staleProbe(e01());
    const agg = aggregateStale([p, null]);
    expect(agg.scenarios_probed).toBe(1);
    expect(agg.stale_citation_detection_recall.n).toBe(p!.truth);
    expect(agg.stale_citation_detection_recall.value).toBe(1);
    expect(aggregateStale([null]).stale_citation_detection_recall.value).toBeNull();
  });

  it("the detector is not vacuous: a corpus in which the cited document is simply absent is flagged too", () => {
    const run = e01();
    const target = run.bundle.citations.find((c) => c.section === "main")!.evidence_item_id;
    const view = { ...run.inputs.view, items: run.inputs.view.items.filter((i) => i.id !== target) };
    expect(detectStaleCitations(run.bundle, view).length).toBeGreaterThan(0);
  });
});

describe("independent checks inside the metrics", () => {
  it("an anchor that is not a verbatim substring of its cited passage is counted as not verbatim", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "fabricated_quote" }), ctx.resolve);
    const f = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(f.anchors_listed).toBeGreaterThan(0);
    expect(f.anchors_verbatim).toBeLessThan(f.anchors_listed);
    expect(f.claims_fully_anchored).toBeLessThan(f.claims);
  });

  it("an anchor attached to a passage the claim does not cite is not counted", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "anchor_wrong_citation" }), ctx.resolve);
    const f = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(f.claims).toBeGreaterThan(0);
    expect(f.claims_fully_anchored).toBeLessThan(f.claims);
    // the quote is verbatim in ITS passage, but that passage is not one the claim cites: it must not count as a verified anchor
    expect(f.anchors_listed).toBeGreaterThan(0);
    expect(f.anchors_verbatim).toBeLessThan(f.anchors_listed);
  });

  it("citation metadata is compared with the database's: a wrong title or publisher is counted as a metadata error", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "valid" }), ctx.resolve);
    expect(r.status).toBe("validated");
    const honest = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(honest.metadata_cited_passages).toBeGreaterThan(0);
    expect(honest.metadata_cited_passages_correct).toBe(honest.metadata_cited_passages);
    const wrong = (id: string) => {
      const m = ctx.resolve(id);
      return m ? { ...m, title: `${m.title} (altered)` } : m;
    };
    const f = generationFacts(run, r, passagesOf(run), wrong, judgments());
    expect(f.metadata_cited_passages_correct).toBe(0);
    expect(f.metadata_cited_passages).toBe(honest.metadata_cited_passages);
  });

  it("the required-opening flag exists only for validated explanations", async () => {
    const run = e01();
    const ok = generationFacts(run, await generateFor(run, new MockProvider({ scenario: "valid" }), ctx.resolve), passagesOf(run), ctx.resolve, judgments());
    const bad = generationFacts(run, await generateFor(run, new MockProvider({ scenario: "mostly_bad" }), ctx.resolve), passagesOf(run), ctx.resolve, judgments());
    expect(ok.opens_with_required_sentence).toBe(true);
    expect(bad.opens_with_required_sentence).toBeNull();
    expect(bad.validated_claims).toBe(0);
  });

  it("dropped claims are classified: unsupported values, hallucinated references and forbidden content are counted separately", async () => {
    const run = e01();
    const count = async (s: MockScenario) => generationFacts(run, await generateFor(run, new MockProvider({ scenario: s }), ctx.resolve), passagesOf(run), ctx.resolve, judgments());
    const number = await count("unsupported_number");
    expect(number.claims_unsupported).toBeGreaterThan(0);
    expect(number.claims_hallucinated).toBeGreaterThan(0);
    expect(number.claims_forbidden).toBe(0);
    const outbreak = await count("outbreak_confirmation");
    expect(outbreak.claims_forbidden).toBeGreaterThan(0);
    const url = await count("url");
    expect(url.claims_forbidden).toBeGreaterThan(0);
    expect(url.claims_unsupported).toBe(0);
  });

  it("evidence coverage counts facets and highly relevant (grade 2) selections that the explanation cites", async () => {
    const run = e01();
    const r = await generateFor(run, new MockProvider({ scenario: "valid" }), ctx.resolve);
    const f = generationFacts(run, r, passagesOf(run), ctx.resolve, judgments());
    expect(f.facets_with_selected).toBeGreaterThanOrEqual(3);
    expect(f.grade2_selected).toBeGreaterThan(0);
    expect(f.grade2_cited).toBeLessThanOrEqual(f.grade2_selected);
    expect(f.facets_with_cited).toBeLessThanOrEqual(f.facets_with_selected);
  });
});
