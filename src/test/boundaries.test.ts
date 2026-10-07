// @vitest-environment node
// M2 is deterministic infrastructure. This guards the stated boundary: no LLM, embedding, vector or
// ML libraries and no AI-vendor calls in application code or dependencies.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const AI_PACKAGES = /(^|\/)(openai|@anthropic-ai|@google\/generative-ai|@google\/genai|langchain|@langchain|llamaindex|cohere-ai|ollama|@huggingface|@xenova|onnxruntime|tensorflow|@tensorflow|pgvector|chromadb|pinecone|weaviate|faiss)/i;

function walk(dir: string, skip: Set<string>): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (skip.has(name)) return [];
    return statSync(full).isDirectory() ? walk(full, skip) : [full];
  });
}

describe("M2 boundary: no AI/ML/vector layer", () => {
  it("package.json declares no AI, embedding or vector dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => AI_PACKAGES.test(d))).toEqual([]);
  });

  it("application source and scripts import no AI SDKs and call no LLM/embedding endpoints", () => {
    const files = [
      ...walk(join(ROOT, "src"), new Set(["legacy", "node_modules"])),
      ...walk(join(ROOT, "scripts"), new Set()),
    ].filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith("database.generated.ts"));
    const banned = /(from\s+["'](openai|@anthropic-ai\/[^"']+|@google\/(generative-ai|genai)|langchain[^"']*)["'])|generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|\bembedding(s)?\b\s*[:(]|new\s+(OpenAI|Anthropic|GoogleGenerativeAI)\b/i;
    const offenders = files.filter((f) => banned.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("migrations create no vector extension/columns and no ML objects", () => {
    const sql = walk(join(ROOT, "supabase", "migrations"), new Set())
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(sql).not.toMatch(/create\s+extension[^;]*vector/i);
    expect(sql).not.toMatch(/\bvector\s*\(\d+\)/i);
    expect(sql).not.toMatch(/\bembedding\b/i);
  });

  it("does not describe signals as confirmed outbreaks in schema or contracts", () => {
    const sql = walk(join(ROOT, "supabase", "migrations"), new Set()).filter((f) => /m2_/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    const identifiers = sql.match(/\b(create\s+(?:table|type|function)\s+public\.\w+|\w+\s+(?:text|boolean|numeric|integer|uuid|timestamptz)\b)/gi) ?? [];
    expect(identifiers.filter((i) => /outbreak|confirmed_case|diagnos/i.test(i))).toEqual([]);
  });
});
