// Fetch ONE allow-listed source through the SSRF-safe fetcher and report what a curator needs to author a
// corpus document: the sanitised-source hash, scanner verdict and a short preview. The full text is NOT saved.
//   npm run evidence:fetch -- https://<allow-listed-host>/path [--lang=en]
// Refuses anything not on data/evidence/allowlist.json (which ships EMPTY: a curator adds domains deliberately).
import { fetchSource } from "../src/evidence/net/fetcher";
import { loadAllowlist } from "../src/evidence/ingest/loader";
import { DEFAULT_ALLOWLIST, arg } from "./lib/evidence-cli";

const url = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!url) {
  console.error("usage: npm run evidence:fetch -- <https-url> [--lang=en|hi|or] [--allowlist=path]");
  process.exit(2);
}
const { allowlist, errors } = loadAllowlist(arg("allowlist") ?? DEFAULT_ALLOWLIST);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const lang = (arg("lang") ?? "en") as "en" | "hi" | "or";
const r = await fetchSource(url, allowlist, lang);
if (r.ok === false) {
  console.error(JSON.stringify({ ok: false, kind: r.kind, reason: r.reason, status: r.status ?? null, redirects: r.redirects }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true, finalUrl: r.finalUrl, contentType: r.contentType, bytes: r.bytes, lastModified: r.lastModified, redirects: r.redirects,
  source_content_hash: r.sourceHash, sanitiser_report: r.sanitised.report,
  scan: { verdict: r.scan.verdict, rules: r.scan.rules, findings: r.scan.findings.map((f) => ({ rule: f.rule, severity: f.severity, where: f.where, excerpt: f.excerpt })) },
  preview: r.sanitised.text.slice(0, 300),
}, null, 2));
