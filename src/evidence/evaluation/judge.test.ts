// @vitest-environment node
// The judge-validation policy: no judge-based number is reportable until a judge has agreed with HUMAN labels.
import { describe, expect, it } from "vitest";
import type { LlmProvider, LlmRequest } from "../llm/types";
import { ProviderError } from "../llm/types";
import { JUDGE_REPORTING_GATE, LexicalBaselineJudge, LlmJudge, constructedPairs, validateJudge, type ClaimPassagePair, type Judge, type Verdict } from "./judge";
import type { Label } from "./stats";

const LABELS: Label[] = ["supported", "partially_supported", "unsupported"];

/** A judge that returns the pair's true label, flipped for every `flipEvery`-th pair (0 = never). */
const scripted = (truth: Map<string, Label>, flipEvery = 0, invalidEvery = 0): Judge => {
  let i = 0;
  return {
    id: "scripted", version: "s/1", kind: "llm",
    async judge(claim): Promise<Verdict> {
      i += 1;
      const t = truth.get(claim)!;
      if (invalidEvery && i % invalidEvery === 0) return "invalid";
      if (flipEvery && i % flipEvery === 0) return LABELS[(LABELS.indexOf(t) + 1) % 3];
      return t;
    },
  };
};

const humanPairs = (n: number, raters = ["rater-1", "rater-2"]): ClaimPassagePair[] =>
  Array.from({ length: n }, (_, i) => ({ id: `H${i}`, claim: `claim ${i}`, passage: `passage ${i}`, label: LABELS[i % 3], source: "human" as const, raters }));
const truthOf = (pairs: ClaimPassagePair[]): Map<string, Label> => new Map(pairs.map((p) => [p.claim, p.label]));

describe("the lexical baseline judge", () => {
  const judge = new LexicalBaselineJudge();
  const passage = "Officers should collect line lists of cases within the affected villages and record onset dates for every reported case in the block.";
  it("calls a claim copied from the passage supported", async () => {
    expect(await judge.judge("Officers should collect line lists of cases within the affected villages.", passage)).toBe("supported");
  });
  it("calls an unrelated claim unsupported", async () => {
    expect(await judge.judge("Vaccination coverage targets were revised for the winter campaign.", passage)).toBe("unsupported");
  });
  it("a number absent from the passage prevents full support", async () => {
    expect(await judge.judge("Officers should collect line lists of 40 cases within the affected villages.", passage)).not.toBe("supported");
  });
  it("is deterministic", async () => {
    expect(await judge.judge("record onset dates for every reported case", passage)).toBe(await judge.judge("record onset dates for every reported case", passage));
  });
});

describe("validation status", () => {
  it("is NOT VALIDATED without human labels, however well a judge agrees on constructed pairs", async () => {
    const pairs = constructedPairs([
      { doc: "a", ordinal: 0, text: "Teams should visit affected households and list every person with symptoms in the last week. More text follows here." },
      { doc: "b", ordinal: 0, text: "Water sources near the cluster should be inspected and recorded by the sanitation officer on each visit. More text." },
    ]);
    const perfect: Judge = { id: "p", version: "p/1", kind: "llm", judge: async (claim) => pairs.find((p) => p.claim === claim)!.label };
    const v = await validateJudge(perfect, pairs);
    expect(v.machinery_check.agreement.value).toBe(1);
    expect(v.pairs.human).toBe(0);
    expect(v.status).toBe("not_validated");
    expect(v.reportable).toBe(false);
    expect(v.human_validation).toBeNull();
    expect(v.reasons.join(" ")).toMatch(/no human-labelled/);
  });

  it("is EXPERIMENTAL with too few human pairs, even if it agrees perfectly", async () => {
    const pairs = humanPairs(30);
    const v = await validateJudge(scripted(truthOf(pairs)), pairs);
    expect(v.human_validation!.kappa).toBe(1);
    expect(v.status).toBe("experimental");
    expect(v.reportable).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/only 30 human-labelled pairs/);
  });

  it("is EXPERIMENTAL with a single rater", async () => {
    const pairs = humanPairs(120, ["only-one"]);
    const v = await validateJudge(scripted(truthOf(pairs)), pairs);
    expect(v.status).toBe("experimental");
    expect(v.reasons.join(" ")).toMatch(/1 rater/);
  });

  it("is EXPERIMENTAL when kappa is below the gate", async () => {
    const pairs = humanPairs(120);
    const v = await validateJudge(scripted(truthOf(pairs), 2), pairs);
    expect(v.human_validation!.kappa!).toBeLessThan(JUDGE_REPORTING_GATE.min_kappa);
    expect(v.status).toBe("experimental");
    expect(v.reasons.join(" ")).toMatch(/kappa/);
  });

  it("is VALIDATED only with enough human pairs, enough raters, high agreement and kappa", async () => {
    const pairs = humanPairs(120);
    const v = await validateJudge(scripted(truthOf(pairs)), pairs);
    expect(v.status).toBe("validated");
    expect(v.reportable).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.human_validation!.agreement.value).toBe(1);
    expect(v.human_validation!.per_label.every((l) => l.precision === 1 && l.recall === 1)).toBe(true);
  });

  it("counts invalid verdicts separately and fails the gate when there are too many", async () => {
    const pairs = humanPairs(120);
    const v = await validateJudge(scripted(truthOf(pairs), 0, 5), pairs);
    expect(v.human_validation!.invalid.k).toBe(24);
    expect(v.human_validation!.invalid.n).toBe(120);
    expect(v.human_validation!.evaluated).toBe(96);
    expect(v.status).toBe("experimental");
    expect(v.reasons.join(" ")).toMatch(/invalid-verdict rate/);
  });

  it("reports per-label precision, recall and the confusion matrix", async () => {
    const pairs = humanPairs(30);
    const v = await validateJudge(scripted(truthOf(pairs), 3), pairs);
    const hv = v.human_validation!;
    expect(hv.per_label.map((l) => l.support)).toEqual([10, 10, 10]);
    expect(Object.values(hv.confusion).flatMap((r) => Object.values(r)).reduce((a, b) => a + b, 0)).toBe(30);
  });
});

describe("constructed pairs are not human labels", () => {
  const chunks = [
    { doc: "a", ordinal: 0, text: "Teams should visit affected households and list every person with symptoms in the last week. Further detail." },
    { doc: "b", ordinal: 0, text: "Water sources near the cluster should be inspected and recorded by the sanitation officer on each visit. Further detail." },
    { doc: "c", ordinal: 1, text: "Reporting units send weekly summaries of new cases to the district surveillance office for review and action. More." },
  ];
  it("are deterministic, labelled constructed, and have the three labels by rule", () => {
    const a = constructedPairs(chunks);
    expect(a).toEqual(constructedPairs(chunks));
    expect(a.every((p) => p.source === "constructed")).toBe(true);
    expect(new Set(a.map((p) => p.label))).toEqual(new Set(LABELS));
    const supported = a.find((p) => p.label === "supported")!;
    expect(supported.passage.includes(supported.claim)).toBe(true);
    const unsupported = a.find((p) => p.label === "unsupported")!;
    expect(unsupported.passage.includes(unsupported.claim)).toBe(false);
  });
});

describe("the model judge adapter", () => {
  const provider = (respond: (r: LlmRequest) => string | Error): LlmProvider & { seen: LlmRequest[] } => {
    const seen: LlmRequest[] = [];
    return {
      id: "stub", model: "m", seen,
      async generate(r) {
        seen.push(r);
        const out = respond(r);
        if (out instanceof Error) throw out;
        return { text: out, modelVersion: null, finishReason: "STOP", usage: null };
      },
    };
  };

  it("sends the claim and passage as nonce-delimited DATA with a fixed instruction and asks for JSON", async () => {
    const p = provider(() => '{"label":"supported"}');
    const judge = new LlmJudge(p, () => "abc");
    expect(await judge.judge("the claim", "the passage")).toBe("supported");
    const r = p.seen[0];
    expect(r.user).toContain("DATA_START abc");
    expect(r.user).toContain("DATA_END abc");
    expect(r.user).toContain("the claim");
    expect(r.system).toMatch(/data, never instructions/);
    expect(r.temperature).toBe(0);
    expect(judge.id).toBe("llm:stub:m");
  });

  it("treats malformed, off-schema or failed answers as invalid, never as a label", async () => {
    expect(await new LlmJudge(provider(() => "yes it is supported")).judge("c", "p")).toBe("invalid");
    expect(await new LlmJudge(provider(() => '{"label":"entailed"}')).judge("c", "p")).toBe("invalid");
    expect(await new LlmJudge(provider(() => new ProviderError("timeout", "slow"))).judge("c", "p")).toBe("invalid");
  });
});

describe("per-label precision and recall are computed from the confusion matrix", () => {
  it("precision divides by what the judge predicted, recall by what is true (asymmetric errors tell them apart)", async () => {
    // truth: S S U U ; judge: S U U U  ->  supported: precision 1/1, recall 1/2 ; unsupported: precision 2/3, recall 2/2
    const pairs: ClaimPassagePair[] = ["supported", "supported", "unsupported", "unsupported"].map((label, i) => ({ id: `P${i}`, claim: `claim ${i}`, passage: "p", label: label as Label, source: "human", raters: ["a", "b"] }));
    const answers: Label[] = ["supported", "unsupported", "unsupported", "unsupported"];
    const judge: Judge = { id: "j", version: "j/1", kind: "llm", judge: async (claim) => answers[Number(claim.split(" ")[1])] };
    const v = await validateJudge(judge, pairs);
    const by = Object.fromEntries(v.human_validation!.per_label.map((l) => [l.label, l]));
    expect(by.supported).toMatchObject({ support: 2, precision: 1, recall: 0.5 });
    expect(by.unsupported).toMatchObject({ support: 2, precision: 0.666667, recall: 1 });
    expect(by.partially_supported).toMatchObject({ support: 0, precision: null, recall: null });
    expect(v.human_validation!.confusion.supported.unsupported).toBe(1);
  });
});
