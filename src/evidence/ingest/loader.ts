// Filesystem loader for the corpus directory and the domain allow-list (curator/CLI side, never the browser).
//   <dir>/docs/*.json   one document edition per file
//   <allowlist file>    optional; a missing file means an EMPTY allow-list (no real source is trusted)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCorpusDocument, type CorpusDocument } from "./document";
import { prepareDocument, type PreparedDocument } from "./prepare";
import { EMPTY_ALLOWLIST, parseAllowlist, type Allowlist } from "./trust";
import { buildManifest, validateCorpus, type CorpusManifest, type CorpusValidation } from "./manifest";

const MAX_FILE_BYTES = 256 * 1024;

export interface LoadedCorpus {
  docs: CorpusDocument[];
  fileErrors: string[];
}

function readJson(path: string): { value?: unknown; error?: string } {
  if (statSync(path).size > MAX_FILE_BYTES) return { error: `file larger than ${MAX_FILE_BYTES} bytes` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8").replace(/^\ufeff/, "")) };
  } catch (e) {
    return { error: `invalid JSON: ${(e as Error).message}` };
  }
}

export function loadCorpusDir(dir: string): LoadedCorpus {
  const docsDir = join(dir, "docs");
  const out: LoadedCorpus = { docs: [], fileErrors: [] };
  if (!existsSync(docsDir)) return { docs: [], fileErrors: [`${docsDir}: directory not found`] };
  for (const name of readdirSync(docsDir).filter((n) => n.endsWith(".json")).sort()) {
    const r = readJson(join(docsDir, name));
    if (r.error) {
      out.fileErrors.push(`${name}: ${r.error}`);
      continue;
    }
    const parsed = parseCorpusDocument(r.value);
    if (!parsed.doc) out.fileErrors.push(...parsed.errors.map((e) => `${name}: ${e}`));
    else {
      if (name !== `${parsed.doc.canonical_id}.json`) out.fileErrors.push(`${name}: file name must be <canonical_id>.json`);
      out.docs.push(parsed.doc);
    }
  }
  return out;
}

export function loadAllowlist(path: string): { allowlist: Allowlist; errors: string[] } {
  if (!existsSync(path)) return { allowlist: EMPTY_ALLOWLIST, errors: [] };
  const r = readJson(path);
  if (r.error) return { allowlist: EMPTY_ALLOWLIST, errors: [`${path}: ${r.error}`] };
  const p = parseAllowlist(r.value);
  return p.allowlist ? { allowlist: p.allowlist, errors: [] } : { allowlist: EMPTY_ALLOWLIST, errors: p.errors.map((e) => `${path}: ${e}`) };
}

export interface BuiltCorpus {
  prepared: PreparedDocument[];
  manifest: CorpusManifest;
  validation: CorpusValidation;
  fileErrors: string[];
}

/** Load, validate, prepare and hash a corpus directory. No database or network access. */
export function buildCorpus(dir: string, allowlistPath: string, corpusName: string): BuiltCorpus {
  const { docs, fileErrors } = loadCorpusDir(dir);
  const al = loadAllowlist(allowlistPath);
  const prepared = docs.map((d) => prepareDocument(d, al.allowlist));
  const validation = validateCorpus(prepared);
  return { prepared, manifest: buildManifest(corpusName, prepared), validation, fileErrors: [...fileErrors, ...al.errors] };
}
