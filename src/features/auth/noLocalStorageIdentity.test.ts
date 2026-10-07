import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const LEGACY_IDENTITY_KEYS = ["isLoggedIn", "userEmail", "userRole", "userId", "userName"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "legacy" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("auth does not use localStorage identity", () => {
  it("active source never references the legacy localStorage identity keys", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const key of LEGACY_IDENTITY_KEYS) {
        if (new RegExp(`localStorage[^\\n]*['"\`]${key}['"\`]`).test(text)) {
          offenders.push(`${relative(SRC, file)}: ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("active source never reads or writes localStorage directly", () => {
    const offenders = walk(SRC)
      .filter((f) => /\blocalStorage\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("active source never imports from the legacy folder", () => {
    const offenders = walk(SRC)
      .filter((f) => /from\s+['"][^'"]*legacy\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
