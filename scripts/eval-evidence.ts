// M4.6 evidence retrieval + grounded generation EVALUATION HARNESS (CLI). It evaluates the unmodified production pipeline over a
// synthetic corpus and synthetic reference judgments. Results demonstrate pipeline correctness, determinism, regression detection and
// metric implementation. They are NOT evidence of real-world retrieval quality, clinical accuracy or public-health usefulness.
//
//   npm run eval:evidence -- --author             write scenario-set.json and judgments.json (deterministic; from doc-roles.json)
//   npm run eval:evidence -- --freeze             write frozen-config.json (do this BEFORE the test split)
//   npm run eval:evidence -- --split=dev          run the dev split (free to inspect)           -> dev-results.json
//   npm run eval:evidence -- --split=test         run the held-out split; REFUSES if anything frozen changed -> test-results.json
//   npm run eval:evidence -- --adversarial        run the adversarial fixtures (REFUSES if anything frozen changed)
//   npm run eval:evidence -- --finalize           recompute everything, require it equals what was stored, write the derived artefacts
//   npm run eval:evidence -- --check              recompute everything and compare with every committed artefact (exit 1 on any difference)
//   npm run eval:evidence -- --real-corpus=FILE   assess a curator-supplied real-corpus package; reports every blocker
//   npm run eval:evidence -- --experiment [--split=dev]   OPT-IN new provider experiment (needs LLM_PROVIDER=gemini + key); never overwrites frozen results
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY } from "../src/evidence/bundle/testkit";
import { createProvider, resolveLlmConfig } from "../src/evidence/llm/config";
import { FILES, EVAL_DIR, author, loadFrozen, writeJson, writeText } from "../src/evidence/evaluation/artifacts";
import { loadDevCorpus } from "../src/evidence/evaluation/devcorpus";
import { aggregateGeneration, generateFor, generationFacts } from "../src/evidence/evaluation/generation";
import { FrozenConfigMismatch, frozenConfig } from "../src/evidence/evaluation/manifest";
import { assessRealCorpus } from "../src/evidence/evaluation/realCorpus";
import { runScenario } from "../src/evidence/evaluation/run";
import { passagesOf } from "../src/evidence/evaluation/run";
import { canonHash, compareWithStored, computeAdversarial, computeSplit, derivedFiles, load, produceAll, requireFrozen } from "../src/evidence/evaluation/produce";
import { currentHashes, loadAuthored, plainHash } from "../src/evidence/evaluation/artifacts";
import { SPLITS, type Split } from "../src/evidence/evaluation/types";
import { arg, flag, loadEnvFile } from "./lib/evidence-cli";

const root = process.cwd();
const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

function refuse(e: unknown): never {
  if (e instanceof FrozenConfigMismatch) {
    console.error(`REFUSED: ${e.message}`);
    for (const d of e.differences) console.error(`  ${d.field}: frozen ${d.frozen.slice(0, 16)}... != current ${d.current.slice(0, 16)}...`);
  } else console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

function printSummary(split: Split, s: ReturnType<typeof import("../src/evidence/evaluation/evaluate").summariseSplit>): void {
  const f = s.retrieval.final.overall;
  const m = (x: { mean: number | null; n: number }) => `${x.mean === null ? "n/a" : x.mean.toFixed(3)} (n=${x.n})`;
  console.log(`\n${split.toUpperCase()}: ${s.scenarios} scenarios ${JSON.stringify(s.by_family)}`);
  console.log(`  final selection  Recall@5 ${m(f.recall_at_5)}  capped ${m(f.capped_recall_at_5)}  Recall@10 ${m(f.recall_at_10)}  P@5 ${m(f.precision_at_5)}  MRR ${m(f.mrr)}  nDCG@10 ${m(f.ndcg_at_10)}`);
  const r = s.retrieval.retrieval.overall;
  console.log(`  retrieval stage  Recall@5 ${m(r.recall_at_5)}  Recall@10 ${m(r.recall_at_10)}  P@5 ${m(r.precision_at_5)}  MRR ${m(r.mrr)}  nDCG@10 ${m(r.ndcg_at_10)}`);
  const rt = (x: { k: number; n: number; value: number | null }) => `${x.k}/${x.n} (${pct(x.value)})`;
  console.log(`  safety           stale ${rt(s.retrieval.stale_evidence.selected_not_in_force)}  wrong-geo ${rt(s.retrieval.wrong_geography.selected_outside_the_signal_place)}  other-ineligible ${rt(s.retrieval.other_ineligible.selected_unverified_other_language_or_synthetic_in_production)}`);
  console.log(`  quality (descr.) duplicates ${rt(s.retrieval.duplicates.selected_that_duplicate_an_earlier_selection)}  irrelevant-selected ${rt(s.retrieval.filler.selected_that_are_irrelevant)}  high-tier share ${rt(s.retrieval.source_quality.selected_from_high_tier)}`);
  const fb = s.retrieval.filler.breakdown;
  console.log(`  irrelevant picks distractor ${fb.annotated_distractor}  other-facet/syndrome ${fb.relevant_to_another_facet_or_syndrome}  other ${fb.other}  | scenarios presenting a distractor ${rt(s.retrieval.filler.scenarios_presenting_an_annotated_distractor)}`);
  console.log(`  abstention       scenarios ${rt(s.retrieval.abstention.no_evidence_scenarios_abstained_correctly)}  facets ${rt(s.retrieval.abstention.facets_without_relevant_evidence_left_empty)}`);
  console.log(`  expectations     safety ${rt(s.retrieval.expectations.safety_checks_passed)}  behaviour ${rt(s.retrieval.expectations.behaviour_checks_passed)}  failed behaviour: ${s.retrieval.expectations.scenarios_with_a_failed_behaviour_check.join(", ") || "none"}`);
  console.log(`  generation       ${JSON.stringify(s.generation.final_status)} fallback ${rt(s.generation.fallback.fallback_rate)} (scripted provider)  valid-answer acceptance ${rt(s.generation.valid_answer_acceptance)}`);
}

async function main(): Promise<void> {
  const real = arg("real-corpus");
  if (real) {
    const r = assessRealCorpus(JSON.parse(readFileSync(real, "utf8")));
    console.log(JSON.stringify(r, null, 2));
    console.log(r.ready ? "READY: the package meets the pre-registered prerequisites (a real-corpus run still needs the curator-supplied views)." : `NOT READY: ${r.blockers.length} blocker(s).`);
    process.exit(r.ready ? 0 : 1);
  }

  if (flag("author")) {
    const base = loadDevCorpus(root);
    const a = author(base, root);
    writeJson(root, FILES.scenarioSet, a.set);
    writeJson(root, FILES.judgments, a.judgments);
    const dev = a.set.scenarios.filter((s) => s.split === "dev").length;
    console.log(`authored ${a.set.scenarios.length} scenarios (dev ${dev}, test ${a.set.scenarios.length - dev}) and ${a.judgments.rows.length} judgment rows -> ${EVAL_DIR}`);
    console.log(`scenario set ${plainHash(a.set)}\njudgments    ${plainHash(a.judgments)}\ndoc roles    ${a.judgments.doc_roles_hash}`);
    if (loadFrozen(root)) console.log("note: a frozen-config.json exists; if the hashes above differ from it, the test split will refuse to run.");
    return;
  }

  if (flag("freeze")) {
    const base = loadDevCorpus(root);
    const authored = loadAuthored(root);
    const hashes = currentHashes(root, authored, base.corpusHash);
    writeJson(root, FILES.frozen, frozenConfig(hashes));
    console.log(`froze ${Object.keys(hashes).length} values -> ${join(EVAL_DIR, FILES.frozen)}`);
    for (const [k, v] of Object.entries(hashes)) console.log(`  ${k.padEnd(34)} ${v}`);
    return;
  }

  if (flag("experiment")) {
    loadEnvFile();
    const choice = resolveLlmConfig(process.env);
    if (choice.kind !== "gemini") {
      console.log(`SKIPPED: ${choice.kind === "none" ? choice.reason : "set LLM_PROVIDER=gemini, GEMINI_API_KEY and LLM_MODEL to run a provider experiment"}`);
      return;
    }
    const split = (arg("split") ?? "dev") as Split;
    if (!SPLITS.includes(split)) refuse(new Error(`unknown split ${split}`));
    const l = load(root);
    if (split === "test") {
      try {
        requireFrozen(l);
      } catch (e) {
        refuse(e);
      }
    }
    const provider = createProvider(choice)!;
    const facts = [];
    const stored = [];
    for (const scenario of l.authored.set.scenarios.filter((s) => s.split === split)) {
      const run = runScenario(l.base, scenario, IDENTITY);
      const gen = await generateFor(run, provider, l.ctx.resolve);
      facts.push(generationFacts(run, gen, passagesOf(run), l.ctx.resolve, l.ctx.judgments));
      stored.push({ scenario: scenario.id, status: gen.status, attempts: gen.attempts.map((a) => ({ outcome: a.outcome, raw: a.raw, parse: a.parse })) });
    }
    mkdirSync(join(root, EVAL_DIR, "experiments"), { recursive: true });
    const name = `${choice.kind}-${choice.model}-${split}.json`.replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileSync(join(root, EVAL_DIR, "experiments", name), `${JSON.stringify({ artefact: "m4-6-provider-experiment", note: "NOT part of the frozen results. Raw model output is stored here for admin inspection only (this directory is git-ignored).", provider: provider.id, model: provider.model, split, config: l.hashes, aggregate: aggregateGeneration(facts, `${provider.id}:${provider.model}`), stored }, null, 2)}\n`);
    console.log(`experiment written to ${join(EVAL_DIR, "experiments", name)} (not part of the frozen results)`);
    return;
  }

  const splitArg = arg("split");
  if (splitArg) {
    if (!SPLITS.includes(splitArg as Split)) refuse(new Error(`unknown split ${splitArg}`));
    const split = splitArg as Split;
    const l = load(root);
    if (split === "test") {
      try {
        requireFrozen(l);
      } catch (e) {
        refuse(e);
      }
      console.log("TEST split (held-out): frozen configuration verified.");
    } else console.log("DEV split (free to inspect).");
    const { run, artefact } = await computeSplit(l, split);
    writeJson(root, split === "dev" ? FILES.dev : FILES.test, artefact);
    const { summariseSplit } = await import("../src/evidence/evaluation/evaluate");
    printSummary(split, summariseSplit(split, run.results));
    console.log(`\nwrote ${join(EVAL_DIR, split === "dev" ? FILES.dev : FILES.test)}`);
    return;
  }

  if (flag("adversarial")) {
    const l = load(root);
    try {
      requireFrozen(l);
    } catch (e) {
      refuse(e);
    }
    const { run, artefact } = await computeAdversarial(l);
    writeJson(root, FILES.adversarial, artefact);
    const r = run.report;
    console.log(`adversarial: ${r.cases} cases (${r.fixtures} fixtures x ${r.scenarios_used} scenarios), unsafe outputs accepted: ${r.unsafe_accepted}, fixtures never challenged: ${r.fixtures_never_challenged.length}`);
    for (const [c, v] of Object.entries(r.by_category)) console.log(`  ${c.padEnd(40)} ${String(v.cases).padStart(4)} cases  ${String(v.challenged).padStart(4)} challenged  unsafe accepted ${v.unsafe_accepted}`);
    process.exit(r.unsafe_accepted === 0 ? 0 : 1);
  }

  if (flag("finalize") || flag("check")) {
    const l = load(root);
    try {
      requireFrozen(l);
    } catch (e) {
      refuse(e);
    }
    const base = loadDevCorpus(root);
    const { authoredDifferences } = await import("../src/evidence/evaluation/artifacts");
    const authoredBad = authoredDifferences(base, root);
    if (authoredBad.length) refuse(new Error(authoredBad.join("; ")));
    const p = await produceAll(l);
    const failedInv = p.invariants.all.filter((i) => i.status === "fail");
    console.log("Safety / integrity invariants (dev + test):");
    for (const i of p.invariants.all) console.log(`  ${i.status === "pass" ? "PASS" : i.status === "fail" ? "FAIL" : "----"}  ${i.id}  ${i.units === 0 ? "not exercised" : `${i.violations} violation(s) of ${i.units}`}  ${i.statement}`);
    console.log(`determinism: ${p.manifest.determinism.rerun_identical ? "recomputed split and adversarial artefacts are identical to the stored ones" : "DIFFERENT from stored artefacts"}`);
    console.log(`judge: ${p.judge.status} (reportable: ${p.judge.reportable})`);

    if (flag("finalize")) {
      if (!p.manifest.determinism.rerun_identical) refuse(new Error("recomputation differs from the stored split / adversarial artefacts; not finalizing"));
      for (const f of derivedFiles(p)) {
        if (f.kind === "json") writeJson(root, f.name, f.value);
        else writeText(root, f.name, f.value as string);
      }
      console.log(`finalized: wrote ${derivedFiles(p).map((f) => f.name).join(", ")}`);
      process.exit(failedInv.length === 0 ? 0 : 1);
    }

    const diff = compareWithStored(l, p);
    console.log(diff.length === 0 ? "check: every committed artefact equals the recomputed artefact" : `check: ${diff.length} artefact(s) differ: ${diff.join(", ")}`);
    console.log(`evaluation code hash ${canonHash(p.manifest.evaluation_code)}`);
    process.exit(diff.length === 0 && failedInv.length === 0 ? 0 : 1);
  }

  console.error("Usage: eval-evidence --author | --freeze | --split=dev|test | --adversarial | --finalize | --check | --real-corpus=FILE | --experiment");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
