// Mutation tests for the major M4.3 safety and ranking rules. Each mutant deliberately breaks ONE rule in the real
// source, runs the unit tests, and must be KILLED (a test fails). A surviving mutant means a rule has no test that
// would notice it breaking. The original file is restored after every mutant, even on Ctrl-C.
//
//   npm run test:mutation:m43
//
// Run it on a clean working tree and do not edit the files while it runs.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Mutant {
  id: string;
  rule: string;
  file: string;
  find: string;
  replace: string;
}
const R = "src/evidence/ranking";
const MUTANTS: Mutant[] = [
  { id: "norm-divisor", rule: "relevance is bm25 / max", file: `${R}/factors.ts`, find: "Math.min(1, s / maximum)", replace: "Math.min(1, s / (maximum + 1))" },
  { id: "class-spacing", rule: "class ladder spacing 0.05 per tier", file: `${R}/policy.ts`, find: "1 - 0.05 * i", replace: "1 - 0.02 * i" },
  { id: "class-unrankable", rule: "unverified/unknown class is never ranked", file: `${R}/factors.ts`, find: "if (idx < 0 || value === null || value === undefined) {", replace: "if (idx < 0) {" },
  { id: "geo-national", rule: "national scope factor 0.85", file: `${R}/policy.ts`, find: "national: 0.85,", replace: "national: 0.9," },
  { id: "geo-own-region", rule: "state/district evidence must be the signal's own", file: `${R}/factors.ts`, find: "const own = meta.geoRegionId !== null && chain.some((r) => r.id === meta.geoRegionId && r.level === scope);", replace: "const own = true;" },
  { id: "time-status", rule: "only current evidence in the main list", file: `${R}/factors.ts`, find: 'if (meta.status !== "current") {', replace: "if (false) {" },
  { id: "time-lookahead", rule: "no look-ahead past the as-of date", file: `${R}/factors.ts`, find: "meta.publicationDate > ctx.asOfDate", replace: "false" },
  { id: "time-expiry", rule: "expired guidance/case definitions excluded", file: `${R}/factors.ts`, find: "meta.validUntil < ctx.asOfDate &&", replace: 'meta.validUntil < "0000-00-00" &&' },
  { id: "time-age-bucket", rule: "situation-report age bucket <= 90 days", file: `${R}/policy.ts`, find: "{ maxDays: 90, factor: 1.0 }", replace: "{ maxDays: 60, factor: 1.0 }" },
  { id: "dedup-threshold", rule: "near-duplicate threshold is inclusive 17/20", file: `${R}/dedup.ts`, find: "intersection * t.denominator >= t.numerator * union", replace: "intersection * t.denominator > t.numerator * union" },
  { id: "dedup-content-hash", rule: "same content hash is a duplicate", file: `${R}/dedup.ts`, find: "k.versionContentHash === candidate.versionContentHash &&", replace: "false &&" },
  { id: "dedup-retention", rule: "retain the higher-tier, more specific candidate", file: `${R}/rank.ts`, find: "a.tier - b.tier || b.geoSpec - a.geoSpec || b.components.rankScore - a.components.rankScore", replace: "b.components.rankScore - a.components.rankScore" },
  { id: "floor", rule: "relevance floor removes weak candidates", file: `${R}/rank.ts`, find: "if (w.relevance < cfg.relevance.floor) {", replace: "if (w.relevance < 0) {" },
  { id: "diversity-document", rule: "at most 2 chunks per document", file: `${R}/rank.ts`, find: "(perDoc.get(doc) ?? 0) >= limits.perDocument", replace: "(perDoc.get(doc) ?? 0) > limits.perDocument" },
  { id: "diversity-publisher", rule: "at most 3 chunks per publisher", file: `${R}/rank.ts`, find: "(perPub.get(pub) ?? 0) >= limits.perPublisher", replace: "(perPub.get(pub) ?? 0) > limits.perPublisher" },
  { id: "top-k", rule: "top-K cut", file: `${R}/rank.ts`, find: "selected.length >= limits.topK", replace: "selected.length > limits.topK" },
  { id: "tiebreak-ids", rule: "canonical id is part of the final tie-break", file: `${R}/rank.ts`, find: "compareCodePoints(a.key, b.key) || a.ordinal - b.ordinal", replace: "a.ordinal - b.ordinal" },
  { id: "historical-successor", rule: "superseded shown only with its successor present", file: `${R}/rank.ts`, find: "if (present.length === 0) {", replace: "if (false) {" },
  { id: "strict-facts", rule: "ranking refuses facts beyond the allowed projection", file: `${R}/rank.ts`, find: "const facts = signalFactsSchema.parse(input.facts);", replace: "const facts = input.facts;" },
  { id: "conflict-needs-two", rule: "a conflict needs two different positions", file: `${R}/conflicts.ts`, find: "if (positions.length < 2) continue;", replace: "if (positions.length < 1) continue;" },
  { id: "gap-local", rule: "missing state/district evidence is reported", file: `${R}/gaps.ts`, find: "if (local.length === 0) {", replace: "if (false) {" },
  { id: "gap-synthetic", rule: "only-synthetic gap requires ALL selected evidence synthetic", file: `${R}/gaps.ts`, find: "selected.every((c) => c.metadata.isSynthetic)", replace: "selected.some((c) => c.metadata.isSynthetic)" },
];

const TESTS = ["src/evidence/ranking"];
const BACKUP = ".mutation-m4-3.bak";
const restoreAll: Array<() => void> = [];
const restore = () => restoreAll.splice(0).forEach((f) => f());
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

let survived = 0;
let invalid = 0;
const rows: string[] = [];
for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    invalid += 1;
    rows.push(`INVALID   ${m.id.padEnd(22)} pattern found ${count} times in ${m.file}`);
    continue;
  }
  copyFileSync(m.file, BACKUP);
  restoreAll.push(() => {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, m.file);
      rmSync(BACKUP);
    }
  });
  writeFileSync(m.file, original.replace(m.find, () => m.replace), "utf8");
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...TESTS, "--reporter=dot"], { encoding: "utf8", timeout: 240_000 });
  restore();
  const killed = r.status !== 0;
  if (!killed) survived += 1;
  const failed = /(\d+) failed/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  rows.push(`${killed ? "KILLED  " : "SURVIVED"}  ${m.id.padEnd(22)} ${m.rule}${killed && failed ? `  (${failed} test(s) failed)` : ""}`);
  console.log(rows[rows.length - 1]);
}
console.log(`\n${MUTANTS.length - survived - invalid}/${MUTANTS.length} mutants killed, ${survived} survived, ${invalid} invalid.`);
if (survived || invalid) process.exit(1);
