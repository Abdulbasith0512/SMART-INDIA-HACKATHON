// Ranking sensitivity analysis over the synthetic development corpus (no database, no network).
//   npm run evidence:sensitivity            write data/evidence/ranking/m4-3-sensitivity-v1.json
//   npm run evidence:sensitivity -- --check fail (exit 1) if the committed report differs from a fresh computation
// The class factors are policy constants; this measures how much the ORDER of eligible evidence moves if they were
// slightly different. It does not tune anything and cannot validate the policy: the corpus is synthetic.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RANKING_CONFIG_V1 } from "../src/evidence/ranking/policy";
import { sensitivityScenarios } from "../src/evidence/ranking/scenarios";
import { analyseSensitivity } from "../src/evidence/ranking/sensitivity";
import { flag } from "./lib/evidence-cli";

const OUT = "data/evidence/ranking/m4-3-sensitivity-v1.json";
const report = analyseSensitivity(sensitivityScenarios(), RANKING_CONFIG_V1);
const text = JSON.stringify(report, null, 2) + "\n";

if (flag("check")) {
  const have = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : null;
  if (have !== text) {
    console.error(`${OUT} differs from a fresh computation`);
    process.exit(1);
  }
  console.log(`unchanged (hash ${report.hash})`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, "utf8");
  console.log(JSON.stringify({ hash: report.hash, totals: report.totals, byFamily: report.byFamily, leadChanges: report.leadChanges.length }, null, 2));
}
