// Mutation tests for the M4.6 evaluation harness: the metric implementations (IR, rates, intervals, kappa), the independent safety
// oracle, the duplicate detector, the judgment rules, the invariant checkers, the adversarial checker, the generation metrics, the
// freeze / refusal logic and the CSV export. Each mutant deliberately breaks ONE rule in the real source, runs the evaluation tests,
// and must be KILLED (a test fails). A surviving mutant means a rule has no test that would notice it breaking - which, for an
// evaluation harness, would let a wrong metric or a missed violation pass silently. The original file is restored after every
// mutant, even on Ctrl-C.
//
//   npm run test:mutation:m46            all mutants
//   npm run test:mutation:m46 -- id,id   only the named mutants
//
// Run it on a clean working tree and do not edit the files while it runs. Only the evaluation HARNESS is mutated, never production code.
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Mutant {
  id: string;
  rule: string;
  file: string;
  find: string;
  replace: string;
  /** Also run the (slow) committed-artefact tests: for mutants that change authored data rather than behaviour. */
  heavy?: boolean;
}
const E = "src/evidence/evaluation";
const m = (id: string, rule: string, file: string, find: string, replace: string, heavy = false): Mutant => ({ id, rule, file: `${E}/${file}`, find, replace, heavy });

const MUTANTS: Mutant[] = [
  // ---- information-retrieval metrics ----
  m("ir-recall-denominator", "Recall@k divides by the number of relevant chunks", "ir.ts", "  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / relevantTotal);", "  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / (relevantTotal + 1));"),
  m("ir-recall-undefined", "Recall is undefined (null) when nothing is relevant", "ir.ts", "relevantTotal: number): number | null {\n  if (relevantTotal === 0) return null;\n  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / relevantTotal);", "relevantTotal: number): number | null {\n  if (relevantTotal === 0) return 1;\n  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / relevantTotal);"),
  m("ir-capped-denominator", "capped Recall divides by min(R, k)", "ir.ts", "/ Math.min(relevantTotal, k));", "/ relevantTotal);"),
  m("ir-capped-undefined", "capped Recall is undefined when nothing is relevant", "ir.ts", "relevantTotal: number): number | null {\n  if (relevantTotal === 0) return null;\n  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / Math.min(", "relevantTotal: number): number | null {\n  if (relevantTotal === 0) return 0;\n  return round6(list.slice(0, k).filter((x) => x.grade >= 1).length / Math.min("),
  m("ir-precision-denominator", "Precision@k divides by what was returned", "ir.ts", "/ top.length);", "/ k);"),
  m("ir-precision-empty", "Precision is undefined when nothing was returned", "ir.ts", "if (top.length === 0) return null;", "if (top.length === 0) return 0;"),
  m("ir-mrr-rank", "MRR is 1 / rank of the first relevant chunk", "ir.ts", "return i < 0 ? 0 : round6(1 / (i + 1));", "return i < 0 ? 0 : round6(1 / (i + 2));"),
  m("ir-mrr-none-returned", "MRR is 0 when relevant chunks exist but none was returned", "ir.ts", "return i < 0 ? 0 :", "return i < 0 ? null :"),
  m("ir-mrr-undefined", "MRR is undefined when nothing is relevant", "ir.ts", "relevantTotal: number): number | null {\n  if (relevantTotal === 0) return null;\n  const i = ", "relevantTotal: number): number | null {\n  if (relevantTotal === 0) return 0;\n  const i = "),
  m("ir-ndcg-discount", "nDCG discounts by 1 / log2(rank + 1)", "ir.ts", "1 / Math.log2(rank1 + 1);", "1 / Math.log2(rank1 + 2);"),
  m("ir-ndcg-ideal", "nDCG's ideal ordering is best-first", "ir.ts", ".sort((a, b) => b - a).slice(0, k);", ".sort((a, b) => a - b).slice(0, k);"),
  m("ir-ndcg-undefined", "nDCG is undefined when the ideal gain is zero", "ir.ts", "if (idcg === 0) return null;", "if (idcg === 0) return 0;"),
  m("ir-ndcg-gain", "nDCG uses the graded (linear) gain", "ir.ts", "s + x.grade * discount(i + 1)", "s + (x.grade > 0 ? 1 : 0) * discount(i + 1)"),
  m("ir-overall-undefined", "a scenario with no defined facet value is excluded, not zero", "ir.ts", "/ vals.length : null;", "/ vals.length : 0;"),
  m("ir-relevant-count", "relevant means grade >= 1", "ir.ts", "const relevant = u.judgedGrades.filter((g) => g >= 1).length;", "const relevant = u.judgedGrades.filter((g) => g >= 2).length;"),

  // ---- rates, intervals, agreement ----
  m("stats-ratio-zero", "a zero denominator gives null", "stats.ts", "(den === 0 ? null : round6(num / den))", "(den === 0 ? 0 : round6(num / den))"),
  m("stats-ci-min-n", "an interval is reported only from n >= 10", "stats.ts", "export const MIN_N_FOR_CI = 10;", "export const MIN_N_FOR_CI = 3;"),
  m("stats-rate-range", "an impossible count is rejected", "stats.ts", "if (k < 0 || k > n) throw new RangeError(", "if (false) throw new RangeError("),
  m("stats-kappa-chance", "kappa's chance agreement uses both raters' marginals", "stats.ts", "pe += (count / n) * ((cb.get(label) ?? 0) / n);", "pe += (count / n) * (count / n);"),
  m("stats-kappa-undefined", "kappa is undefined when chance agreement is 1", "stats.ts", "if (pe >= 1) return null;", "if (pe > 1) return null;"),

  // ---- the independent safety oracle ----
  m("oracle-status", "only current documents may be presented", "oracle.ts", 'if (d.status !== "current") out.push(', "if (false) out.push("),
  m("oracle-unverified-class", "an unverified source class is forbidden", "oracle.ts", 'if (d.sourceClass === "unverified" || d.trustLevel === "unreviewed")', 'if (d.trustLevel === "unreviewed")'),
  m("oracle-unverified-trust", "an unreviewed trust level is forbidden", "oracle.ts", 'if (d.sourceClass === "unverified" || d.trustLevel === "unreviewed")', 'if (d.sourceClass === "unverified")'),
  m("oracle-language", "only English is eligible", "oracle.ts", 'if (d.language !== "en")', "if (false)"),
  m("oracle-synthetic", "synthetic documents are ineligible in production only", "oracle.ts", 'if (d.isSynthetic && ctx.profile === "production")', "if (d.isSynthetic)"),
  m("oracle-geo-level", "local evidence must match the place AND its level", "oracle.ts", "r.id === d.geoRegionId && r.level === d.geoScope", "r.id === d.geoRegionId"),
  m("oracle-geo-scope", "both state and district scopes are place-checked", "oracle.ts", '(d.geoScope === "state" || d.geoScope === "district") &&', '(d.geoScope === "state") &&'),
  m("oracle-published", "nothing is published after the as-of date", "oracle.ts", "d.publicationDate > ctx.asOf", "d.publicationDate >= ctx.asOf"),
  m("oracle-not-yet-valid", "nothing that is not yet valid", "oracle.ts", "if (d.validFrom && d.validFrom > ctx.asOf)", "if (false)"),
  m("oracle-expiring-kinds", "case definitions expire as well as guidance", "oracle.ts", 'new Set(["operational_guidance", "case_definition"])', 'new Set(["operational_guidance"])'),
  m("oracle-expiry-bound", "expired means valid_until is before the as-of date", "oracle.ts", "d.validUntil < ctx.asOf", "d.validUntil <= ctx.asOf"),
  m("oracle-stale-class", "a non-current status is a stale reason", "oracle.ts", 'r.startsWith("status:") || r === "published_after_as_of"', 'r === "published_after_as_of"'),

  // ---- per-scenario evaluation ----
  m("eval-dup-threshold", "a near-copy is a duplicate from Jaccard 0.85", "scenarioEval.ts", "return j >= 0.85 ||", "return j >= 0.95 ||"),
  m("eval-dup-family-threshold", "an annotated redundant copy counts from 0.5", "scenarioEval.ts", "&& j >= 0.5);", "&& j >= 0.9);"),
  m("eval-dup-different-doc", "a family duplicate needs a different document", "scenarioEval.ts", "e.canonicalId !== c.canonicalId && ", ""),
  m("eval-stale-detect", "stale evidence being presented is detected", "scenarioEval.ts", "if (reasons.some(isStaleReason)) safety.stale.push(", "if (false) safety.stale.push("),
  m("eval-geo-detect", "wrong-place evidence being presented is detected", "scenarioEval.ts", "if (reasons.some(isGeoReason)) safety.wrong_geography.push(tag);", ";"),
  m("eval-other-detect", "unverified / non-English evidence being presented is detected", "scenarioEval.ts", "if (reasons.some(isOtherIneligibleReason)) safety.other_ineligible.push(", "if (false) safety.other_ineligible.push("),
  m("eval-local-correct", "correctly placed local evidence is counted", "scenarioEval.ts", "if (!reasons.some(isGeoReason)) safety.local_correct += 1;", "safety.local_correct += 1;"),
  m("eval-duplicates-counted", "duplicates are counted per facet", "scenarioEval.ts", "safety.duplicates += countDuplicates(", "safety.duplicates += 0 * countDuplicates("),
  m("eval-abstain-gap", "correct abstention needs the explicit gap", "scenarioEval.ts", 'abstained && gaps.includes("no_eligible_evidence")', "abstained"),
  m("eval-abstain-check", "an abstaining scenario must present nothing", "scenarioEval.ts", '"safety", got.totalSelected === 0,', '"safety", true,'),
  m("eval-high-tier", "high tier is the first three source classes", "scenarioEval.ts", "SOURCE_CLASS_TIERS.slice(0, 3)", "SOURCE_CLASS_TIERS.slice(0, 2)"),

  // ---- aggregation ----
  m("agg-stale", "the stale rate counts stale presentations", "aggregate.ts", "rate(sum(evals, (e) => e.safety.stale.length), selected)", "rate(0, selected)"),
  m("agg-abstain", "scenario abstention counts only correct abstentions", "aggregate.ts", "expectedAbstain.filter((e) => e.abstention.correct === true).length", "expectedAbstain.length"),

  // ---- reference judgments ----
  m("judge-abstract-cap", "an abstract chunk is capped at grade 1", "judgments.ts", 'if (c.kind === "abstract" && grade > 1) {', "if (false) {"),
  m("judge-aged-cap", "an aged situation report is capped at grade 1", "judgments.ts", "daysBetween(item.publicationDate, ctx.asOf) > AGED_DAYS", "daysBetween(item.publicationDate, ctx.asOf) > 100000"),
  m("judge-syndrome", "a document about one syndrome applies only to it", "judgments.ts", "const applies = item.syndromes.length === 0 || item.syndromes.includes(inputs.facts.syndrome);", "const applies = true;"),
  m("judge-ineligible", "a not-presentable document is graded 0", "judgments.ts", "if (reasons.length) {", "if (false) {"),

  // ---- invariants and regression ----
  m("inv-not-exercised", "an invariant with no data is not 'pass'", "invariants.ts", 'status: units === 0 ? "not_exercised" : violations === 0', 'status: units === 0 ? "pass" : violations === 0'),
  m("inv-fail", "a violation fails the invariant", "invariants.ts", ': violations === 0 ? "pass" : "fail"', ': violations === 0 ? "pass" : "pass"'),
  m("inv-stale-count", "S04 counts stale presentations", "invariants.ts", "selected, sum((e) => e.safety.stale.length))", "selected, 0)"),
  m("inv-abstain-no-call", "S08 requires that no model was called", "invariants.ts", "r.generation.stored.attempts.length === 0 &&", "true &&"),
  m("inv-false-confidence", "S09 flags a validated explanation without evidence", "invariants.ts", 'noEvidence.filter((r) => r.generation.facts.status === "validated")', 'noEvidence.filter((r) => r.generation.facts.status === "rejected")'),
  m("inv-stale-control", "S12 fails on a stale flag in an unchanged corpus", "invariants.ts", "(p.truth - p.detected) + p.false_positives + p.control_false_positives", "(p.truth - p.detected) + p.false_positives"),
  m("regress-baseline", "only a pass -> fail flip is a regression", "invariants.ts", "was.get(s.id) === true && !s.safety_checks_passed", "!s.safety_checks_passed"),
  m("regress-review", "a metric below the baseline's interval needs review", "invariants.ts", "m.mean < b.ci95[0]", "m.mean > b.ci95[0]"),

  // ---- the judge-validation policy ----
  m("judge-numbers", "the lexical baseline requires the claim's numbers", "judge.ts", "const numbersOk = numbers(claim).every((n) => passageNumbers.has(n));", "const numbersOk = true;"),
  m("judge-min-pairs", "validation needs enough human pairs", "judge.ts", "if (human.length < g.min_pairs)", "if (false)"),
  m("judge-min-raters", "validation needs at least two raters", "judge.ts", "if (raters < g.min_raters)", "if (false)"),
  m("judge-kappa-gate", "validation needs kappa above the floor", "judge.ts", "if (hv.kappa === null || hv.kappa < g.min_kappa)", "if (false)"),
  m("judge-initial-status", "a judge starts as not validated", "judge.ts", 'let status: JudgeStatus = "not_validated";', 'let status: JudgeStatus = "experimental";'),
  m("judge-recall", "per-label recall divides by the true count", "judge.ts", "recall: ratio(tp, actual)", "recall: ratio(tp, predicted)"),

  // ---- the real-corpus gate ----
  m("rc-synthetic", "one synthetic document blocks a real-corpus run", "realCorpus.ts", "if (c.synthetic_documents > 0)", "if (c.synthetic_documents > 1)"),
  m("rc-raters", "two raters are required", "realCorpus.ts", "if (pkg.raters.length < REAL_CORPUS_GATE.min_raters)", "if (pkg.raters.length < 1)"),
  m("rc-kappa", "inter-rater agreement must reach the floor", "realCorpus.ts", "if (minKappa !== null && minKappa < REAL_CORPUS_GATE.min_kappa)", "if (false)"),
  m("rc-frozen", "adjudicated judgments must be frozen", "realCorpus.ts", "if (pkg.judgments_frozen_hash === null)", "if (false)"),

  // ---- adversarial checker ----
  m("adv-payload", "a planted payload in an accepted explanation is found", "adversarial.ts", "if (re.test(text)) out.push(", "if (false) out.push("),
  m("adv-token", "an unknown citation token is found", "adversarial.ts", "if (!ids.has(m[1])) out.push(", "if (false) out.push("),
  m("adv-anchor", "a non-verbatim anchor is found", "adversarial.ts", "if (t === undefined || !strict(t).includes(strict(a.quote))) out.push(", "if (false) out.push("),
  m("adv-opening", "a missing required opening is found", "adversarial.ts", 'if (!e.text.startsWith("Evidence relevant to this emerging signal suggests…\\n")) out.push(', "if (false) out.push("),
  m("adv-unsafe-flag", "findings make the case unsafe", "adversarial.ts", "unsafe_accepted: reasons.length > 0", "unsafe_accepted: false"),
  m("adv-summary-count", "the summary counts unsafe acceptances", "adversarial.ts", "if (o.unsafe_accepted) c.unsafe_accepted += 1;", "if (false) c.unsafe_accepted += 1;"),
  m("adv-vacuous", "a fixture that never challenged a defence is reported", "adversarial.ts", ".filter(([, v]) => v.challenged === 0)", ".filter(([, v]) => v.challenged === -1)"),
  m("adv-withheld", "a passage withheld from the prompt counts as an engaged defence", "adversarial.ts", "a.withheld.length > 0 || ", ""),

  // ---- generation metrics ----
  m("gen-skipped-cause", "a skipped generation is fallback extraction", "generation.ts", 'if (r.status === "skipped") return "fallback_extraction";', 'if (r.status === "skipped") return "provider_failure";'),
  m("gen-stale-status", "a document that is no longer current makes its citation stale", "generation.ts", '!item || item.status !== "current" || item.version?.contentHash', "!item || item.version?.contentHash"),
  m("gen-stale-hash", "a changed document makes its citation stale", "generation.ts", 'item.status !== "current" || item.version?.contentHash !== c.version_content_hash', 'item.status !== "current"'),
  m("gen-citation-exists", "citation existence is checked against the bundle", "generation.ts", "if (ids.has(c)) f.citations_existing += 1;", "f.citations_existing += 1;"),
  m("gen-anchor-verbatim", "an anchor must be a verbatim substring", "generation.ts", "p.citations.includes(an.citation) && verbatim(text, an.quote)", "p.citations.includes(an.citation)"),
  m("gen-anchor-cited", "an anchor must belong to a cited passage", "generation.ts", "p.citations.includes(an.citation) && verbatim(text, an.quote)", "verbatim(text, an.quote)"),
  m("gen-in-text-citation", "an id written only in the claim text is a citation reference", "generation.ts", "[...p.citations, ...(p.text.match(/\\[(E\\d+)\\]/g) ?? []).map((t) => t.slice(1, -1))]", "[...p.citations]"),
  m("gen-fully-anchored", "a claim is complete only if every reference exists and is anchored", "generation.ts", "refs.size > 0 && [...refs].every(", "p.citations.length > 0 && [...p.citations].every("),
  m("gen-metadata", "shown metadata is compared with the database's", "generation.ts", "segment.includes(`Source: ${m.title} - ${m.publisher}`)", "true"),
  m("gen-fallback-rate", "the fallback rate counts every non-validated outcome", "generation.ts", "rate(facts.length - statuses.validated, facts.length)", "rate(statuses.rejected, facts.length)"),

  // ---- freeze / refusal and hashing ----
  m("frozen-diff", "a changed frozen value is detected", "manifest.ts", ".filter((k) => frozen[k] !== current[k])", ".filter(() => false)"),
  m("frozen-assert", "the held-out split refuses on a difference", "manifest.ts", "if (diff.length) throw new FrozenConfigMismatch(diff);", ";"),
  m("frozen-missing", "the held-out split refuses without a freeze", "manifest.ts", "if (!frozen) throw new Error(", "if (false) throw new Error("),
  m("hash-ignores-tests", "test files are not part of the production-sources hash", "artifacts.ts", String.raw`/\.ts$/.test(n) && !/\.test\.ts$/.test(n)`, String.raw`/\.ts$/.test(n)`),
  m("hash-line-endings", "source hashes ignore line endings", "artifacts.ts", String.raw`s.replace(/\r\n/g, "\n")`, "s"),
  m("split-frozen", "the dev / test split is fixed by the authoring rule", "authoring.ts", 'ordered.forEach((o, i) => split.set(o.s.id, i % 2 === 0 ? "dev" : "test"));', 'ordered.forEach((o, i) => split.set(o.s.id, i % 2 === 0 ? "test" : "dev"));', true),

  // ---- review export ----
  m("csv-formula", "spreadsheet formulas are neutralised", "review.ts", String.raw`if (/^[=+\-@\t\r]/.test(s)) s =`, "if (false) s ="),
  m("csv-quote", "cells with commas, quotes or newlines are quoted", "review.ts", String.raw`return /[",\n\r]/.test(s) ?`, "return false ?"),
];

const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const allTests = readdirSync(E).filter((f) => f.endsWith(".test.ts")).map((f) => `${E}/${f}`);
const FAST = allTests.filter((f) => !f.endsWith("artifacts.test.ts"));
const BACKUP = ".mutation-m4-6.bak";
const restoreAll: Array<() => void> = [];
const restore = () => restoreAll.splice(0).forEach((f) => f());
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

// every pattern must match exactly once, before anything is changed
let invalid = 0;
for (const x of MUTANTS) {
  const n = readFileSync(x.file, "utf8").split(x.find).length - 1;
  if (n !== 1) {
    invalid += 1;
    console.log(`INVALID   ${x.id.padEnd(26)} pattern found ${n} times in ${x.file}`);
  }
}
if (invalid) process.exit(1);
if (new Set(MUTANTS.map((x) => x.id)).size !== MUTANTS.length) {
  console.log("duplicate mutant ids");
  process.exit(1);
}

let survived = 0;
let ran = 0;
const survivors: string[] = [];
for (const x of MUTANTS) {
  if (only && !only.has(x.id)) continue;
  const original = readFileSync(x.file, "utf8");
  copyFileSync(x.file, BACKUP);
  restoreAll.push(() => {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, x.file);
      rmSync(BACKUP);
    }
  });
  writeFileSync(x.file, original.replace(x.find, () => x.replace), "utf8");
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...(x.heavy ? allTests : FAST), "--reporter=dot", "--bail=1"], { encoding: "utf8", timeout: 400_000 });
  restore();
  ran += 1;
  const killed = r.status !== 0;
  if (!killed) {
    survived += 1;
    survivors.push(x.id);
  }
  const failed = /(\d+) failed/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  console.log(`${killed ? "KILLED  " : "SURVIVED"}  ${x.id.padEnd(26)} ${x.rule}${killed && failed ? `  (${failed} test(s) failed)` : ""}`);
}
console.log(`\n${ran - survived}/${ran} mutants killed, ${survived} survived.${survivors.length ? ` Survivors: ${survivors.join(", ")}` : ""}`);
if (survived) process.exit(1);
