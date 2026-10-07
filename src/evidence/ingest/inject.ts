// Prompt-injection pattern scanner for evidence text.
//
// Evidence is DATA. A document that tries to give instructions to a reader, a summariser or a tool is not
// trustworthy evidence, so it is quarantined for curator review instead of being indexed. This scanner is a
// HEURISTIC first line of defence: it is deterministic and conservative (over-quarantine is cheap, a missed
// injection is not), but it is NOT complete. The real defences are structural (plain-text only, evidence
// wrapped as data, constrained JSON output, deterministic citation/forbidden-content validators, humans verify).
//
// Coverage limits, stated plainly: patterns are English-centric; one best-effort Hindi family is included and
// has NOT been reviewed by a native speaker; Odia injection phrasing is not covered at all.
import { sanitizeText, type RemovedFragment, type SanitiseReport } from "./sanitize";

export const INJECTION_SCANNER_VERSION = "inject-scan/1.0.0";

export type ScanSeverity = "warn" | "block";
export type ScanVerdict = "clean" | "warn" | "quarantine";

export interface InjectionFinding {
  rule: string;
  severity: ScanSeverity;
  where: "text" | "removed_content" | "structure";
  /** Bounded, already-sanitised excerpt for curators. Never stored in the corpus manifest. */
  excerpt: string;
}

export interface ScanResult {
  verdict: ScanVerdict;
  findings: InjectionFinding[];
  /** Unique, sorted rule ids (what the manifest records). */
  rules: string[];
}

export interface ScanContext {
  report?: SanitiseReport;
  removedFragments?: RemovedFragment[];
  language?: "en" | "hi" | "or";
}

interface TextRule {
  id: string;
  severity: ScanSeverity;
  on: "fold" | "text";
  re: RegExp;
}

const INSTRUCTION_NOUN = String.raw`(?:instructions?|prompts?|rules?|guidelines?|directions?|constraints?|context|commands?)`;
const RULES: TextRule[] = [
  {
    id: "instruction_override", severity: "block", on: "fold",
    re: new RegExp(String.raw`\b(?:ignore|disregard|forget|override|bypass|discard|skip)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|these|the|system|every)\b[^.\n]{0,30}\b${INSTRUCTION_NOUN}\b`),
  },
  {
    id: "role_reassignment", severity: "block", on: "fold",
    re: /\b(?:you are now|from now on,? you|you will now|act as (?:a|an|if)\b|pretend (?:to be|you are)|roleplay as|assume the role|your new (?:role|task|instructions?)|new instructions?\s*:)/,
  },
  { id: "role_marker_privileged", severity: "block", on: "fold", re: /^\s*(?:system|assistant|developer)\s*:/m },
  { id: "role_marker_conversational", severity: "warn", on: "fold", re: /^\s*(?:user|human|ai)\s*:/m },
  {
    id: "chat_template_token", severity: "block", on: "fold",
    re: /<\|[a-z_]+\|>|\[\/?inst\]|<<\/?sys>>|###\s*(?:instruction|system|response)\b|\bbegin (?:system|prompt)\b|\bend of (?:prompt|system)\b/,
  },
  {
    id: "tool_call_markup", severity: "block", on: "fold",
    re: /\b(?:tool_calls?|function_call|tool_use)\b|<\s*(?:tool|function)[^>]*>|"name"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"/,
  },
  {
    id: "prompt_exfiltration", severity: "block", on: "fold",
    re: /\b(?:reveal|show|print|repeat|output|display|leak|disclose)\b[^.\n]{0,30}\b(?:system prompt|your (?:system )?(?:prompt|instructions)|hidden (?:prompt|instructions)|initial prompt)\b/,
  },
  {
    id: "summariser_directive", severity: "block", on: "fold",
    re: /\b(?:when|if)\s+you\s+(?:are\s+)?(?:asked\s+to\s+)?(?:summari[sz]\w*|explain\w*)\b|\b(?:in|for)\s+your\s+(?:summary|response|answer|output|explanation)\b[^.\n]{0,40}\b(?:always|must|should|never|only)\b|\brespond only with\b|\b(?:do not|don't|never)\s+(?:mention|disclose|tell)\b[^.\n]{0,30}\b(?:this|these)\s+(?:instructions?|document|text)\b/,
  },
  {
    id: "forced_conclusion", severity: "block", on: "fold",
    re: /\b(?:declare|state|conclude|confirm|announce|report)\b[^.\n]{0,40}\b(?:outbreak|epidemic|cluster)\b[^.\n]{0,25}\b(?:confirmed|is real|has been confirmed|is occurring)\b/,
  },
  { id: "self_authenticating_claim", severity: "warn", on: "fold", re: /\b(?:this|the) (?:document|text|source) (?:confirms|proves|establishes)\b/ },
  { id: "markdown_image", severity: "block", on: "text", re: /!\[[^\]]*\]\([^)]*\)/ },
  { id: "markdown_link", severity: "block", on: "text", re: /\[[^\]]{0,200}\]\(\s*(?:https?:|javascript:|data:|mailto:)[^)]*\)/i },
  { id: "script_uri", severity: "block", on: "fold", re: /\b(?:javascript|vbscript)\s*:|data:[a-z]+\/[a-z0-9.+-]+[;,]/ },
  { id: "url_in_text", severity: "warn", on: "text", re: /\b(?:https?:\/\/|www\.)[^\s)>\]]+/i },
  { id: "encoded_blob", severity: "block", on: "text", re: /[A-Za-z0-9+/]{80,}={0,2}/ },
  { id: "percent_or_unicode_escape_run", severity: "block", on: "text", re: /(?:%[0-9a-f]{2}){12,}|(?:\\u[0-9a-f]{4}){6,}/i },
  { id: "code_fence", severity: "warn", on: "text", re: /```/ },
  { id: "shell_or_code_execution", severity: "block", on: "fold", re: /\b(?:rm -rf|curl\s+-|wget\s+https?|powershell\s+-|cmd\.exe|os\.system|subprocess\.|eval\()/ },
  { id: "overlong_token", severity: "warn", on: "text", re: /\S{200,}/ },
  // Best-effort Hindi (NOT native-reviewed): "...instructions ... ignore" in either order.
  {
    id: "instruction_override_hi", severity: "block", on: "text",
    re: /निर्देश[^\n.।]{0,40}(?:अनदेखा|नज़रअंदाज़|नजरअंदाज)|(?:अनदेखा|नज़रअंदाज़|नजरअंदाज)[^\n.।]{0,40}निर्देश/,
  },
];

// Phrases checked after removing every non-letter/digit, to catch spacing/punctuation evasion ("i g n o r e ...").
const SQUASHED_OVERRIDES = [
  "ignorepreviousinstructions", "ignoreallpreviousinstructions", "ignoretheaboveinstructions", "ignoreallinstructions",
  "disregardpreviousinstructions", "disregardtheaboveinstructions", "forgetpreviousinstructions", "forgetallpreviousinstructions",
];

/** NFKC + lowercase; keeps newlines (line-anchored rules need them), collapses other whitespace. */
export function foldForScan(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\S\n]+/g, " ");
}

const squash = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "");
const excerptOf = (s: string, index: number, length: number): string =>
  sanitizeText(s.slice(Math.max(0, index - 10), index + Math.min(length, 70))).text.slice(0, 80);

function scanText(text: string, where: "text" | "removed_content", out: InjectionFinding[]): void {
  const folded = foldForScan(text);
  const bump = (sev: ScanSeverity): ScanSeverity => (where === "removed_content" ? "block" : sev);
  const seen = new Set<string>();
  for (const rule of RULES) {
    const subject = rule.on === "fold" ? folded : text;
    const m = rule.re.exec(subject);
    if (m) {
      seen.add(rule.id);
      out.push({ rule: rule.id, severity: bump(rule.severity), where, excerpt: excerptOf(subject, m.index, m[0].length) });
    }
  }
  if (!seen.has("instruction_override")) {
    const sq = squash(folded);
    const hit = SQUASHED_OVERRIDES.find((p) => sq.includes(p));
    if (hit) out.push({ rule: "instruction_override_obfuscated", severity: "block", where, excerpt: hit });
  }
  const tokens = folded.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  let latinCyrillic = "";
  let latinGreek = "";
  for (const t of tokens) {
    if (/\p{Script=Latin}/u.test(t) && /\p{Script=Cyrillic}/u.test(t)) latinCyrillic ||= t;
    else if (/\p{Script=Latin}/u.test(t) && /\p{Script=Greek}/u.test(t)) latinGreek ||= t;
  }
  if (latinCyrillic) out.push({ rule: "mixed_script_latin_cyrillic", severity: bump("block"), where, excerpt: latinCyrillic.slice(0, 40) });
  if (latinGreek) out.push({ rule: "mixed_script_latin_greek", severity: bump("warn"), where, excerpt: latinGreek.slice(0, 40) });
}

function structural(report: SanitiseReport, language: ScanContext["language"], out: InjectionFinding[]): void {
  const add = (rule: string, severity: ScanSeverity, excerpt: string) => out.push({ rule, severity, where: "structure", excerpt });
  if (report.hiddenElementsRemoved > 0 || report.hiddenMarkers > 0) add("hidden_content", "block", `hidden elements=${report.hiddenElementsRemoved} markers=${report.hiddenMarkers}`);
  if (report.htmlCommentsRemoved > 0) add("html_comment", "warn", `comments=${report.htmlCommentsRemoved}`);
  if (report.bidiControlsRemoved > 0) add("bidi_controls", "block", `count=${report.bidiControlsRemoved}`);
  if (report.tagCharsRemoved > 0) add("unicode_tag_characters", "block", `count=${report.tagCharsRemoved}`);
  if (report.invisibleCharsRemoved > 0) {
    const n = report.invisibleCharsRemoved;
    const heavy = n >= 8 || (n >= 3 && n / Math.max(1, report.inputLength) > 0.01);
    add("invisible_characters", heavy ? "block" : "warn", `count=${report.invisibleCharsRemoved}`);
  }
  if (report.controlCharsRemoved > 0) add("control_characters", "warn", `count=${report.controlCharsRemoved}`);
  if (report.loneSurrogatesReplaced > 0) add("lone_surrogates", "warn", `count=${report.loneSurrogatesReplaced}`);
  // Joiners are legitimate in Indic scripts; in English text they are an anomaly.
  if (report.joinersRemoved > 0 && (language ?? "en") === "en") add("joiners_in_latin_text", "warn", `count=${report.joinersRemoved}`);
}

/** Scan SANITISED text (plus what the sanitiser removed). Pure and deterministic. */
export function scanForInjection(text: string, ctx: ScanContext = {}): ScanResult {
  const findings: InjectionFinding[] = [];
  if (ctx.report) structural(ctx.report, ctx.language, findings);
  scanText(text, "text", findings);
  for (const frag of ctx.removedFragments ?? []) scanText(sanitizeText(frag.text).text, "removed_content", findings);
  const rules = [...new Set(findings.map((f) => f.rule))].sort();
  const verdict: ScanVerdict = findings.some((f) => f.severity === "block") ? "quarantine" : findings.length ? "warn" : "clean";
  return { verdict, findings, rules };
}
