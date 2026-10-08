// Mutation tests for the M4.5 validator boundaries and the generation flow. Each mutant deliberately breaks ONE rule in the
// real source, runs the generation unit tests and the generation database tests, and must be KILLED (a test fails). A
// surviving mutant means a rule has no test that would notice it breaking. The original file is restored after every mutant,
// even on Ctrl-C.
//
//   npm run test:mutation:m45              all mutants
//   npm run test:mutation:m45 -- id,id     only the named mutants
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
const L = "src/evidence/llm";
const raw = String.raw;

const MUTANTS: Mutant[] = [
  // ---- anchors: the approved normalisation and the "verbatim" proof ----
  { id: "anchor-nfc", rule: "anchors are compared after Unicode NFC", file: `${L}/normalize.ts`, find: 's.normalize("NFC").replace(WHITESPACE, " ").trim();', replace: 's.replace(WHITESPACE, " ").trim();' },
  { id: "anchor-whitespace", rule: "anchors are compared after whitespace collapsing", file: `${L}/normalize.ts`, find: 's.normalize("NFC").replace(WHITESPACE, " ").trim();', replace: 's.normalize("NFC").trim();' },
  { id: "anchor-case-sensitive", rule: "anchors are case-sensitive (no other normalisation)", file: `${L}/normalize.ts`, find: 'return normaliseForAnchor(passage).includes(q) ? "ok" : "not_verbatim";', replace: 'return normaliseForAnchor(passage).toLowerCase().includes(q.toLowerCase()) ? "ok" : "not_verbatim";' },
  { id: "anchor-min-chars", rule: "an anchor needs at least 12 characters", file: `${L}/normalize.ts`, find: "export const MIN_ANCHOR_CHARS = 12;", replace: "export const MIN_ANCHOR_CHARS = 3;" },
  { id: "anchor-min-words", rule: "an anchor needs at least 3 words", file: `${L}/normalize.ts`, find: "export const MIN_ANCHOR_WORDS = 3;", replace: "export const MIN_ANCHOR_WORDS = 1;" },
  { id: "hidden-characters", rule: "hidden characters are detected", file: `${L}/normalize.ts`, find: 'HIDDEN.test(s.replace(ORDINARY_WHITESPACE, " "));', replace: "false;" },
  { id: "non-latin", rule: "non-Latin letters (look-alikes) are detected", file: `${L}/normalize.ts`, find: "NON_LATIN_LETTER.test(s);", replace: "false;" },

  // ---- forbidden-content scanner ----
  { id: "scan-fold", rule: "scanning folds text (NFKC, case, hidden characters) so obfuscation cannot hide a word", file: `${L}/forbidden.ts`, find: "findings.push(...run(RULES, folded, text));", replace: "findings.push(...run(RULES, text.toLowerCase(), text));" },
  { id: "scan-hidden-flag", rule: "hidden characters in model text are refused", file: `${L}/forbidden.ts`, find: 'if (hasHiddenCharacters(text)) findings.push({ rule: "unicode.hidden", category: "hidden_unicode" });', replace: 'if (false) findings.push({ rule: "unicode.hidden", category: "hidden_unicode" });' },
  { id: "scan-non-latin-flag", rule: "non-English text in model output is refused", file: `${L}/forbidden.ts`, find: 'if (hasNonLatinLetters(text)) findings.push({ rule: "unicode.non-latin", category: "non_english_text" });', replace: 'if (false) findings.push({ rule: "unicode.non-latin", category: "non_english_text" });' },
  { id: "scan-citation-strip", rule: "citation tokens are ignored when scanning (so [E1][E2] is not a markdown link)", file: `${L}/forbidden.ts`, find: "const folded = foldForScan(text).replace(CITATION_TOKEN, \" \");", replace: "const folded = foldForScan(text);" },
  { id: "scan-advice-modal", rule: "advice wording (should / must) is refused unless it is reported speech about a source", file: `${L}/forbidden.ts`, find: "if (ADVICE_MODAL.test(folded) && !ATTRIBUTION.test(folded)) findings.push(", replace: "if (false) findings.push(" },
  { id: "scan-causal-source-bound", rule: "a causal word is allowed only when the statement's own anchors use it", file: `${L}/forbidden.ts`, find: "if (!anchors.includes(m[0])) {", replace: "if (false) {" },
  { id: "scan-anchor-steering-only", rule: "anchor quotes are scanned for steering content only", file: `${L}/forbidden.ts`, find: "return run(RULES.filter((r) => r.anchors), folded, quote);", replace: "return run(RULES, folded, quote);" },
  { id: "scan-anchor-all-rules-off", rule: "anchor quotes ARE scanned for steering content", file: `${L}/forbidden.ts`, find: "return run(RULES.filter((r) => r.anchors), folded, quote);", replace: "return [];" },
  // one mutant per security-critical category: the rule is silently skipped
  ...(
    [
      ["forbidden_outbreak_confirmation", "outbreak confirmation"],
      ["forbidden_diagnosis", "diagnosis and disease causation"],
      ["forbidden_treatment_advice", "treatment and response advice"],
      ["forbidden_overclaim", "certainty overclaims"],
      ["forbidden_instruction", "instructions addressed to the reader"],
      ["forbidden_instruction_override", "instruction override"],
      ["forbidden_role_manipulation", "role manipulation"],
      ["forbidden_tool_call", "tool-call markup"],
      ["forbidden_code_execution", "code execution"],
      ["forbidden_secret_request", "requests for secrets"],
      ["forbidden_url", "URLs"],
      ["forbidden_markdown_link", "markdown links"],
      ["forbidden_image", "images"],
      ["forbidden_html", "HTML"],
      ["forbidden_encoded_blob", "encoded payloads"],
    ] as const
  ).map(([category, label]): Mutant => ({
    id: `rule-${category.replace("forbidden_", "")}`,
    rule: `${label} is refused`,
    file: `${L}/forbidden.ts`,
    find: "for (const r of rules) if (r.re.test(r.raw ? original : folded)) out.push({ rule: r.id, category: r.category });",
    replace: `for (const r of rules) if (r.category !== "${category}" && r.re.test(r.raw ? original : folded)) out.push({ rule: r.id, category: r.category });`,
  })),
  // one mutant per individual rule: that rule alone is silently skipped
  ...[
    "override.ignore-instructions", "override.new-instructions", "override.persona", "role.line-start", "role.system-message", "role.chat-tokens", "tool.markup", "tool.names", "tool.json",
    "tool.call-request", "code.fence", "code.script", "code.call", "code.shell", "code.run-request", "secret.request", "secret.material", "url.scheme", "url.domain", "markdown.inline-link",
    "markdown.reference-link", "image.markup", "html.tag", "blob.base64", "blob.hex", "blob.mention", "outbreak.assert-verb", "outbreak.assert-state", "outbreak.there-is",
    "outbreak.signal-is-real", "diagnosis.word", "diagnosis.patient", "diagnosis.cue-then-disease", "diagnosis.this-is-disease", "treatment.terms", "overclaim.certainty",
    "instruction.second-person", "instruction.imperative",
  ].map((id): Mutant => ({
    id: `only-rule-${id}`,
    rule: `rule ${id} is individually necessary`,
    file: `${L}/forbidden.ts`,
    find: "for (const r of rules) if (r.re.test(r.raw ? original : folded)) out.push({ rule: r.id, category: r.category });",
    replace: `for (const r of rules) if (r.id !== "${id}" && r.re.test(r.raw ? original : folded)) out.push({ rule: r.id, category: r.category });`,
  })),

  // ---- number / date / name / term support ----
  { id: "support-digits", rule: "digits in a statement are checked", file: `${L}/support.ts`, find: "out.add(canonicalNumber(m[0]));", replace: "void m;" },
  { id: "support-number-words", rule: "spelled-out numbers are checked", file: `${L}/support.ts`, find: "if (m[1]) out.add(String(TENS_WORDS[m[1]] + (m[2] ? ONES[m[2]] : 0)));", replace: "if (m[1]) void m;" },
  { id: "support-date-period", rule: "a date is supported only by an equal or more specific date", file: `${L}/support.ts`, find: "if (claim.length === 7 || claim.length === 4) return [...support].some((s) => s.startsWith(claim));\n  return false;", replace: "return true;" },
  { id: "support-years", rule: "bare years are recognised as dates", file: `${L}/support.ts`, find: raw`take(/\b(1[89]\d{2}|20\d{2})\b/g, (m) => m[1]);`, replace: ";" },
  { id: "support-acronym-case", rule: "an acronym must match in its own capitals", file: `${L}/support.ts`, find: ".includes(acronym);", replace: ".map((x) => x.toUpperCase()).includes(acronym);" },
  { id: "support-every-word", rule: "every word of a multi-word name must be supported", file: `${L}/support.ts`, find: "tokens.every((w) => (isAcronym(w)", replace: "tokens.some((w) => (isAcronym(w)" },
  { id: "support-acronym-not-stopword", rule: "an acronym such as WHO is never discarded as a stop word", file: `${L}/support.ts`, find: "!isAcronym(words[0]) && STOP_STARTERS", replace: "STOP_STARTERS" },
  { id: "support-disease-terms", rule: "disease names are checked", file: `${L}/support.ts`, find: "for (const m of folded.matchAll(DISEASE_RE)) out.add(m[0]);", replace: "for (const m of folded.matchAll(DISEASE_RE)) void m;" },
  { id: "support-outbreak-terms", rule: "outbreak words are checked", file: `${L}/support.ts`, find: 'for (const m of folded.matchAll(OUTBREAK_RE)) out.add(m[0].replace(/s$/, ""));', replace: "for (const m of folded.matchAll(OUTBREAK_RE)) void m;" },

  // ---- schema ----
  { id: "schema-strict-root", rule: "unknown top-level fields are refused", file: `${L}/schema.ts`, find: ".max(MAX_NOTES),\n  })\n  .strict();", replace: ".max(MAX_NOTES),\n  });" },
  { id: "schema-enum", rule: "the statement kind is a closed enum", file: `${L}/schema.ts`, find: "kind: z.enum(POINT_KINDS),", replace: "kind: z.string()," },
  { id: "schema-citation-id", rule: "citation ids must look like E1", file: `${L}/schema.ts`, find: raw`const CITATION_ID = /^E[1-9]\d{0,3}$/;`, replace: "const CITATION_ID = /^.*$/;" },
  { id: "schema-unique-citations", rule: "a statement's citations are unique", file: `${L}/schema.ts`, find: "new Set(p.citations).size === p.citations.length", replace: "true" },
  { id: "schema-json-only", rule: "the answer must be bare JSON (no fences)", file: `${L}/schema.ts`, find: "json = JSON.parse(raw.trim());", replace: 'json = JSON.parse(raw.trim().replace(/^```(?:json)?|```$/g, ""));' },
  { id: "schema-min-points", rule: "an answer needs at least one statement", file: `${L}/schema.ts`, find: "points: z.array(pointSchema).min(1).max(MAX_POINTS),", replace: "points: z.array(pointSchema).max(MAX_POINTS)," },

  // ---- citation, anchor and support validation ----
  { id: "validate-citation-unknown", rule: "a citation outside the bundle is refused", file: `${L}/validate.ts`, find: "if (!known.has(id) || !passages.has(id)) failures.push(", replace: "if (false) failures.push(" },
  { id: "validate-citation-withheld", rule: "a citation to a passage that was not sent is refused", file: `${L}/validate.ts`, find: "else if (!sent.has(id)) failures.push(", replace: "else if (false) failures.push(" },
  { id: "validate-citation-count", rule: "synthesis / agreement / disagreement need two citations", file: `${L}/validate.ts`, find: "if (point.citations.length < MIN_CITATIONS[point.kind]) failures.push(", replace: "if (false) failures.push(" },
  { id: "validate-min-citations-table", rule: "the minimum citations per kind", file: `${L}/validate.ts`, find: "synthesis: 2, agreement: 2, disagreement: 2", replace: "synthesis: 1, agreement: 1, disagreement: 1" },
  { id: "validate-anchor-citation", rule: "an anchor must cite an id of its own statement", file: `${L}/validate.ts`, find: "if (!point.citations.includes(a.citation)) {", replace: "if (false) {" },
  { id: "validate-anchor-verbatim", rule: "an anchor must be a verbatim substring of the cited passage", file: `${L}/validate.ts`, find: "const status = anchorStatus(passage.text, a.quote);", replace: 'const status = "ok" as ReturnType<typeof anchorStatus>;' },
  { id: "validate-anchor-steering", rule: "steering content inside an anchor is refused", file: `${L}/validate.ts`, find: "const steering = scanAnchor(a.quote);", replace: "const steering: ReturnType<typeof scanAnchor> = [];" },
  { id: "validate-anchor-hijack-level", rule: "steering content inside an anchor refuses the whole generation", file: `${L}/validate.ts`, find: "for (const f of steering) if (GENERATION_LEVEL.has(f.category)) failures.push(", replace: "for (const f of steering) if (false) failures.push(" },
  { id: "validate-citation-anchored", rule: "every cited id needs an anchor", file: `${L}/validate.ts`, find: "for (const id of citable) if (!anchored.has(id)) failures.push(", replace: "for (const id of citable) if (false) failures.push(" },
  { id: "validate-text-scan", rule: "statement text is scanned for forbidden content", file: `${L}/validate.ts`, find: "for (const f of scanModelText(point.text, { anchorText: foldForScan(verified.join(\" \")) })) failures.push(", replace: "for (const f of [] as ReturnType<typeof scanModelText>) failures.push(" },
  { id: "validate-causal-anchor-text", rule: "causal wording is bound to the statement's own verified anchors", file: `${L}/validate.ts`, find: 'anchorText: foldForScan(verified.join(" "))', replace: 'anchorText: foldForScan(citable.map((id) => passages.get(id)!.text).join(" "))' },
  { id: "validate-fabricated-id", rule: "a citation id in the text that the statement does not cite is refused", file: `${L}/validate.ts`, find: "if (!point.citations.includes(m[0])) failures.push(", replace: "if (false) failures.push(" },
  { id: "validate-support", rule: "numbers, dates, names and terms must be supported", file: `${L}/validate.ts`, find: "failures.push(...supportFailures(report, `${at}.text`));", replace: "void report;" },
  { id: "validate-support-facts", rule: "the signal facts may support a number, date or name", file: `${L}/validate.ts`, find: "[...verified, factsText]", replace: "[...verified]" },
  { id: "validate-support-verified-only", rule: "only VERIFIED anchors support a claim", file: `${L}/validate.ts`, find: "[...verified, factsText]", replace: "[...point.anchors.map((a) => a.quote), factsText]" },
  { id: "validate-drop-fraction", rule: "more than half of the statements dropped refuses the generation", file: `${L}/validate.ts`, find: "droppedPoints / total > policy.maxDropFraction", replace: "droppedPoints / total >= policy.maxDropFraction" },
  { id: "validate-no-valid", rule: "a generation with no surviving statement is refused", file: `${L}/validate.ts`, find: 'if (!rejection && kept.length === 0) rejection = "no_valid_points";', replace: ";" },
  { id: "validate-generation-level", rule: "steering content refuses the whole generation", file: `${L}/validate.ts`, find: "failures.find((f) => GENERATION_LEVEL.has(f.category))?.category ?? null;", replace: "null;" },
  { id: "validate-notes", rule: "notes with forbidden or unsupported content are dropped", file: `${L}/validate.ts`, find: "if (f.length === 0) ok.push(t);", replace: "ok.push(t);" },
  { id: "types-generation-level", rule: "instruction override is a generation-level failure", file: `${L}/types.ts`, find: '  "forbidden_instruction_override", "forbidden_role_manipulation", "forbidden_tool_call", "forbidden_code_execution", "forbidden_secret_request",\n]);', replace: '  "forbidden_role_manipulation", "forbidden_tool_call", "forbidden_code_execution", "forbidden_secret_request",\n]);' },

  // ---- generation flow ----
  { id: "flow-max-attempts", rule: "exactly one retry, never a third attempt", file: `${L}/generate.ts`, find: "export const MAX_ATTEMPTS = 2;", replace: "export const MAX_ATTEMPTS = 3;" },
  { id: "flow-retryable", rule: "a blocked request is not retried", file: `${L}/generate.ts`, find: 'new Set(["timeout", "unavailable", "rate_limited"])', replace: 'new Set(["timeout", "unavailable", "rate_limited", "blocked", "unauthorized", "bad_request"])' },
  { id: "flow-correction", rule: "the retry carries a corrective instruction", file: `${L}/generate.ts`, find: "correction = [...new Set([outcome.rejection!, ...(Object.keys(outcome.categories) as FailureCategory[])])].slice(0, 8);", replace: "correction = undefined;" },
  { id: "flow-empty-skip", rule: "an empty bundle is not sent to a model", file: `${L}/generate.ts`, find: 'if (!bundle.citations.some((c) => c.section === "main")) return finish("skipped"', replace: 'if (false) return finish("skipped"' },
  { id: "flow-no-provider", rule: "no provider means the fallback, without a call", file: `${L}/generate.ts`, find: 'if (!provider) return finish("unavailable"', replace: 'if (false) return finish("unavailable"' },
  { id: "flow-hang-guard", rule: "a provider that never answers is cut off", file: `${L}/generate.ts`, find: "ms + 250);", replace: "ms + 250000);" },
  { id: "flow-status", rule: "a refused answer is 'rejected', an outage is 'unavailable'", file: `${L}/generate.ts`, find: 'attempts.some((a) => a.outcome === "rejected") ? "rejected" : "unavailable"', replace: '"unavailable"' },
  { id: "flow-sent-set", rule: "only passages that were sent are citable", file: `${L}/generate.ts`, find: "sent: new Set(prompt.sent)", replace: "sent: new Set(bundle.citations.map((c) => c.citation_id))" },
  { id: "flow-fallback-flag", rule: "fallback_used is true unless a validated explanation exists", file: `${L}/generate.ts`, find: 'fallback_used: status !== "validated",', replace: "fallback_used: false," },

  // ---- prompt ----
  { id: "prompt-nonce", rule: "a fresh nonce for every request", file: `${L}/prompt.ts`, find: 'export const makeNonce = (): string => randomBytes(12).toString("hex");', replace: 'export const makeNonce = (): string => "fixednonce0123456789abcd";' },
  { id: "prompt-nonce-collision", rule: "a nonce that occurs inside a passage is refused", file: `${L}/prompt.ts`, find: "for (let tries = 0; sent.some((id) => passages.get(id)!.text.includes(nonce)); tries += 1) {", replace: "for (let tries = 0; false; tries += 1) {" },
  { id: "prompt-historical", rule: "historical context is not sent to the model", file: `${L}/prompt.ts`, find: 'if (c.section !== "main") {', replace: "if (false) {" },
  { id: "prompt-hidden", rule: "a passage with hidden characters is withheld", file: `${L}/prompt.ts`, find: 'if (hasHiddenCharacters(p.text)) withheld.push(', replace: "if (false) withheld.push(" },
  { id: "prompt-max-passages", rule: "too many passages are refused", file: `${L}/prompt.ts`, find: "if (sent.length > MAX_PASSAGES) throw new PromptError(", replace: "if (false) throw new PromptError(" },
  { id: "prompt-max-chars", rule: "too many characters are refused", file: `${L}/prompt.ts`, find: "if (total > MAX_PASSAGE_CHARS_TOTAL) throw new PromptError(", replace: "if (false) throw new PromptError(" },
  { id: "prompt-correction-vocabulary", rule: "the retry message names only fixed categories", file: `${L}/prompt.ts`, find: ".filter((c) => (FAILURE_CATEGORIES as readonly string[]).includes(c))", replace: ".filter(() => true)" },
  { id: "prompt-input-hash", rule: "the input hash covers the passage text", file: `${L}/prompt.ts`, find: "passages: sent.map((id) => [id, sha256Hex(passages.get(id)!.text)]),", replace: "passages: sent.map((id) => [id])," },
  { id: "prompt-data-block", rule: "passages are delimited by this request's nonce", file: `${L}/prompt.ts`, find: "`DATA_START ${nonce}`,", replace: '"DATA_START",' },

  // ---- rendering ----
  { id: "render-opening", rule: "the explanation opens with the required sentence", file: `${L}/render.ts`, find: "t(`${FALLBACK_OPENING}", replace: "t(`This outbreak report ${FALLBACK_OPENING}" },
  { id: "render-sections", rule: "evidence statements and synthesis are separate sections", file: `${L}/render.ts`, find: 'kept.filter((p) => p.kind === "evidence_statement" || p.kind === "terminology")', replace: "kept" },
  { id: "render-gaps", rule: "the engine's gaps are always shown", file: `${L}/render.ts`, find: 'parts.push({ kind: "gap", text: g.message });', replace: "void g;" },
  { id: "render-model-label", rule: "model-listed missing evidence is labelled as the model's", file: `${L}/render.ts`, find: 't("- (listed by the model) ");', replace: 't("- ");' },
  { id: "render-withhold", rule: "a cited passage carrying steering text is not echoed", file: `${L}/render.ts`, find: "scanAnchor(passage.text).length ? PASSAGE_WITHHELD_NOTICE : passage.text", replace: "passage.text" },
  { id: "render-metadata", rule: "source details must come from the database", file: `${L}/render.ts`, find: "if (!m) throw new Error(`explanation: no database metadata", replace: "if (false) throw new Error(`explanation: no database metadata" },

  // ---- providers ----
  { id: "config-default-mock", rule: "the default provider is the mock", file: `${L}/config.ts`, find: '.toLowerCase() || "mock";', replace: '.toLowerCase() || "none";' },
  { id: "config-needs-key", rule: "a live call needs GEMINI_API_KEY", file: `${L}/config.ts`, find: 'if (!apiKey) return { kind: "none"', replace: 'if (false) return { kind: "none"' },
  { id: "config-needs-model", rule: "a live call needs LLM_MODEL", file: `${L}/config.ts`, find: 'if (!model) return { kind: "none"', replace: 'if (false) return { kind: "none"' },
  { id: "config-model-valid", rule: "the model identifier is validated", file: `${L}/config.ts`, find: 'if (!MODEL_ID.test(model)) return { kind: "none"', replace: 'if (false) return { kind: "none"' },
  { id: "gemini-key-header", rule: "the key travels in a header, never the URL", file: `${L}/gemini.ts`, find: "(this.model)}:generateContent`, {", replace: "(this.model)}:generateContent?key=${this.apiKey}`, {" },
  { id: "gemini-no-tools", rule: "no tools are requested", file: `${L}/gemini.ts`, find: "systemInstruction: { parts: [{ text: request.system }] },", replace: "systemInstruction: { parts: [{ text: request.system }] },\n    tools: [{ googleSearch: {} }]," },
  { id: "gemini-redact", rule: "the key is redacted from error text", file: `${L}/gemini.ts`, find: 'return s.split(this.apiKey).join("[redacted]").slice(0, 300);', replace: "return s.slice(0, 300);" },
  { id: "gemini-timeout", rule: "the request is aborted at the timeout", file: `${L}/gemini.ts`, find: "const timer = setTimeout(() => controller.abort(), request.timeoutMs);", replace: "const timer = setTimeout(() => undefined, request.timeoutMs);" },
  { id: "gemini-thoughts", rule: "reasoning (thought) parts are never part of the answer", file: `${L}/gemini.ts`, find: "p.thought !== true", replace: "true" },
  { id: "gemini-status-429", rule: "HTTP 429 is a rate limit", file: `${L}/gemini.ts`, find: 'res.status === 429 ? "rate_limited"', replace: 'res.status === 429 ? "unavailable"' },
  { id: "gemini-model-id", rule: "the model identifier cannot change the request path", file: `${L}/gemini.ts`, find: "if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(o.model)) throw", replace: "if (false) throw" },

  // ---- persistence ----
  { id: "persist-cache", rule: "identical inputs are served from the cache", file: `${L}/persist.ts`, find: "      if (hit) {", replace: "      if (false) {" },
  { id: "persist-verify-gate", rule: "a bundle that does not verify is never explained", file: `${L}/persist.ts`, find: "if (!verification.ok) throw new Error(", replace: "if (false) throw new Error(" },
  { id: "persist-outage", rule: "an outage or an empty bundle is not stored", file: `${L}/persist.ts`, find: 'if (result.status === "unavailable" || result.status === "skipped") return {', replace: "if (false) return {" },
  { id: "persist-status", rule: "a refused generation is stored as rejected", file: `${L}/persist.ts`, find: 'status: result.status === "validated" ? "validated" : "rejected",', replace: 'status: "validated",' },
  { id: "persist-raw", rule: "the raw answer is stored", file: `${L}/persist.ts`, find: 'if (raw) await db.insert("generated_explanation_raw"', replace: 'if (false) await db.insert("generated_explanation_raw"' },
  { id: "persist-converge", rule: "a concurrent writer converges on the stored row", file: `${L}/persist.ts`, find: "if (!existing) throw e;", replace: "throw e;" },
  { id: "persist-citations-idempotent", rule: "citation rows are not duplicated", file: `${L}/persist.ts`, find: "if (have.has(`${r.claim_index}|${item}`)) continue;", replace: "if (false) continue;" },
  { id: "persist-reval-hash", rule: "re-validation recomputes the output hash", file: `${L}/persist.ts`, find: "if (report.output_hash !== hashJson(explanation)) problems.push(", replace: "if (false) problems.push(" },
  { id: "persist-reval-validators", rule: "re-validation re-runs the validators", file: `${L}/persist.ts`, find: "if (!again.accepted || again.dropped.length) problems.push(", replace: "if (false) problems.push(" },
  { id: "persist-reval-stale", rule: "re-validation reports changed source details", file: `${L}/persist.ts`, find: "if (rendered.text !== explanation.text) stale.push(", replace: "if (false) stale.push(" },
  { id: "persist-select-preference", rule: "a validated explanation is preferred to the fallback", file: `${L}/persist.ts`, find: 'rows.find((r) => r.status === "validated") ?? rows.find((r) => r.status === "fallback_extractive")', replace: 'rows.find((r) => r.status === "fallback_extractive") ?? rows.find((r) => r.status === "validated")' },
];

const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const TESTS = [L, "src/test/db/m4.llm.db.test.ts"];
const BACKUP = ".mutation-m4-5.bak";
const restoreAll: Array<() => void> = [];
const restore = () => restoreAll.splice(0).forEach((f) => f());
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

// every pattern must match exactly once, before anything is changed
let invalid = 0;
for (const m of MUTANTS) {
  const n = readFileSync(m.file, "utf8").split(m.find).length - 1;
  if (n !== 1) {
    invalid += 1;
    console.log(`INVALID   ${m.id.padEnd(30)} pattern found ${n} times in ${m.file}`);
  }
}
if (new Set(MUTANTS.map((m) => m.id)).size !== MUTANTS.length) {
  console.log("INVALID   duplicate mutant ids");
  invalid += 1;
}
if (invalid) process.exit(1);

let survived = 0;
let ran = 0;
const survivors: string[] = [];
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const original = readFileSync(m.file, "utf8");
  copyFileSync(m.file, BACKUP);
  restoreAll.push(() => {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, m.file);
      rmSync(BACKUP);
    }
  });
  writeFileSync(m.file, original.replace(m.find, () => m.replace), "utf8");
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...TESTS, "--reporter=dot", "--bail=1"], { encoding: "utf8", timeout: 300_000 });
  restore();
  ran += 1;
  const killed = r.status !== 0;
  if (!killed) {
    survived += 1;
    survivors.push(m.id);
  }
  console.log(`${killed ? "KILLED  " : "SURVIVED"}  ${m.id.padEnd(30)} ${m.rule}`);
}
console.log(`\n${ran - survived}/${ran} mutants killed, ${survived} survived.${survivors.length ? ` Survivors: ${survivors.join(", ")}` : ""}`);
if (survived) process.exit(1);
