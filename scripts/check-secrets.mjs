// Fails if tracked-style source files contain JWT-like strings or known demo passwords.
// Skips node_modules, build output, lockfiles, git data, and this script itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".claude"]);
const SKIP_FILES = new Set(["package-lock.json", "bun.lockb", "check-secrets.mjs"]);
const SKIP_PREFIXES = [`supabase${sep}.temp`];
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|toml|html|css|yml|yaml|env|example|txt|sh)$/i;

const PATTERNS = [
  { name: "JWT-like token", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { name: "bare eyJ token", re: /["'`]eyJ[A-Za-z0-9._-]{20,}/ },
  { name: "demo password", re: /password123/i },
  { name: "service role key assigned to VITE_ variable", re: /VITE_[A-Z_]*SERVICE_ROLE/ },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(full));
    } else if (!SKIP_FILES.has(name) && (TEXT_EXT.test(name) || name.startsWith(".env"))) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT)) {
  // .env.local style files are git-ignored and may legitimately hold secrets.
  if (/^\.env(\.|$)/.test(file.split(sep).pop()) && !file.endsWith(".env.example")) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push(`${relative(ROOT, file)}:${i + 1}  ${name}`);
    }
  });
}

if (findings.length) {
  console.error("Secret scan FAILED:\n" + findings.join("\n"));
  process.exit(1);
}
console.log("Secret scan passed.");
