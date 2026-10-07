// Evidence sanitiser. Everything that enters the corpus becomes PLAIN TEXT: markup, hidden content, control
// characters and invisible/bidirectional Unicode are removed (and counted), so that downstream code and the
// LLM only ever see inert text. The rules mirror the database CHECK constraints on evidence_chunks and
// evidence_versions.abstract (migration m4_evidence): output of this module always satisfies them.
//
// Evidence is DATA, never instructions. Sanitising does not make text trustworthy; the injection scanner and
// the trust rules decide that. Removal counts and removed hidden fragments are returned so the scanner can
// treat concealment itself as a signal.

export const SANITISER_VERSION = "sanitise/1.0.0";

export interface SanitiseReport {
  inputLength: number;
  outputLength: number;
  htmlCommentsRemoved: number;
  scriptStyleBlocksRemoved: number;
  hiddenElementsRemoved: number;
  /** Raw occurrences of hiding markers (display:none, hidden attribute, font-size:0 ...). */
  hiddenMarkers: number;
  htmlTagsRemoved: number;
  entitiesDecoded: number;
  controlCharsRemoved: number;
  /** Zero-width and other invisible format characters (excluding joiners and bidi controls). */
  invisibleCharsRemoved: number;
  bidiControlsRemoved: number;
  /** Unicode "tag" characters (U+E0000 block), used for ASCII smuggling. */
  tagCharsRemoved: number;
  /** U+200C / U+200D. Legitimate in Indic scripts but disallowed by the database plain-text constraint. */
  joinersRemoved: number;
  loneSurrogatesReplaced: number;
}

export interface RemovedFragment {
  kind: "comment" | "hidden_element";
  text: string;
}

export interface SanitiseResult {
  text: string;
  report: SanitiseReport;
  removedFragments: RemovedFragment[];
}

// ---- character classes built from code points (keeps control characters out of the source text) ----
type Range = number | [number, number];
const hex4 = (cp: number): string => (cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`);
const cls = (ranges: Range[]): RegExp =>
  new RegExp(`[${ranges.map((r) => (Array.isArray(r) ? `${hex4(r[0])}-${hex4(r[1])}` : hex4(r))).join("")}]`, "gu");

const RX_TAG_CHARS = cls([[0xe0000, 0xe007f]]);
const RX_BIDI = cls([0x061c, 0x200e, 0x200f, [0x202a, 0x202e], [0x2066, 0x2069]]);
const RX_JOINERS = cls([0x200c, 0x200d]);
const RX_INVISIBLE = cls([
  0x200b, [0x2060, 0x206f], 0x00ad, 0x034f, 0x180e, 0xfeff, 0x115f, 0x1160, 0x3164, 0xffa0, [0xfff9, 0xfffb],
  [0xfe00, 0xfe0f], [0xe0100, 0xe01ef], [0xe000, 0xf8ff],
]);
const RX_SPACES = cls([0x00a0, 0x1680, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000]);
const RX_TAB_VT_FF = cls([0x09, 0x0b, 0x0c]);
const RX_LINE_BREAKS = new RegExp(`${hex4(0x0d)}${hex4(0x0a)}|[${hex4(0x0d)}${hex4(0x2028)}${hex4(0x2029)}${hex4(0x85)}]`, "gu");
const RX_CONTROLS = cls([[0x00, 0x08], [0x0e, 0x1f], [0x7f, 0x9f]]);
const RX_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Same tag shape as the database CHECK (`<\s*/?\s*[a-zA-Z!][^>]*>`), so nothing the DB would reject survives.
const RX_TAG = /<\s*\/?\s*[a-zA-Z!][^>]*>/g;
const RX_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const RX_SCRIPT_LIKE = /<\s*(script|style|noscript|template|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi;
const HIDING = String.raw`display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|\bhidden\b|aria-hidden\s*=\s*["']?true`;
const RX_HIDDEN_ELEMENT = new RegExp(String.raw`<\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*(?:${HIDING})[^>]*>[\s\S]*?<\s*\/\s*\1\s*>`, "gi");
const RX_HIDING_MARKER = new RegExp(HIDING, "gi");
const RX_BLOCK_TAG = /^<\s*\/?\s*(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|blockquote|pre|hr)\b/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: "(c)",
};
const MAX_FRAGMENTS = 20;
const MAX_FRAGMENT_LENGTH = 500;

function emptyReport(inputLength: number): SanitiseReport {
  return {
    inputLength, outputLength: 0, htmlCommentsRemoved: 0, scriptStyleBlocksRemoved: 0, hiddenElementsRemoved: 0, hiddenMarkers: 0,
    htmlTagsRemoved: 0, entitiesDecoded: 0, controlCharsRemoved: 0, invisibleCharsRemoved: 0, bidiControlsRemoved: 0,
    tagCharsRemoved: 0, joinersRemoved: 0, loneSurrogatesReplaced: 0,
  };
}

function replaceCounting(s: string, rx: RegExp, to: string | ((m: string) => string), onCount: (n: number) => void): string {
  let n = 0;
  const out = s.replace(rx, (m) => {
    n += 1;
    return typeof to === "string" ? to : to(m);
  });
  if (n) onCount(n);
  return out;
}

function htmlPass(input: string, rep: SanitiseReport, frags: RemovedFragment[]): string {
  let s = input;
  const keep = (kind: RemovedFragment["kind"], text: string) => {
    if (frags.length < MAX_FRAGMENTS) frags.push({ kind, text: text.slice(0, MAX_FRAGMENT_LENGTH) });
  };
  s = replaceCounting(s, RX_COMMENT, (m) => {
    keep("comment", m.replace(/^<!--/, "").replace(/-->$/, ""));
    return " ";
  }, (n) => (rep.htmlCommentsRemoved += n));
  s = replaceCounting(s, RX_SCRIPT_LIKE, " ", (n) => (rep.scriptStyleBlocksRemoved += n));
  // Hiding markers only mean something inside markup, so count them only when markup is present.
  if (s.includes("<")) rep.hiddenMarkers += (s.match(RX_HIDING_MARKER) ?? []).length;
  s = replaceCounting(s, RX_HIDDEN_ELEMENT, (m) => {
    keep("hidden_element", m.replace(/<[^>]*>/g, " ")); // inner text only, so the scanner can read what was hidden
    return " ";
  }, (n) => (rep.hiddenElementsRemoved += n));
  s = replaceCounting(s, RX_TAG, (m) => (RX_BLOCK_TAG.test(m) ? "\n" : ""), (n) => (rep.htmlTagsRemoved += n));
  s = s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, body: string) => {
    let out: string | undefined;
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      out = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    } else out = NAMED_ENTITIES[body.toLowerCase()];
    if (out === undefined) return m;
    rep.entitiesDecoded += 1;
    return out;
  });
  return s;
}

function charPass(input: string, rep: SanitiseReport): string {
  let s = input.normalize("NFC");
  s = s.replace(RX_LINE_BREAKS, "\n");
  s = replaceCounting(s, RX_TAG_CHARS, "", (n) => (rep.tagCharsRemoved += n));
  s = replaceCounting(s, RX_BIDI, "", (n) => (rep.bidiControlsRemoved += n));
  s = replaceCounting(s, RX_JOINERS, "", (n) => (rep.joinersRemoved += n));
  s = replaceCounting(s, RX_INVISIBLE, "", (n) => (rep.invisibleCharsRemoved += n));
  s = s.replace(RX_SPACES, " ").replace(RX_TAB_VT_FF, " ");
  s = replaceCounting(s, RX_CONTROLS, "", (n) => (rep.controlCharsRemoved += n));
  s = s.normalize("NFC");
  return s
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sanitise untrusted text into inert plain text. Deterministic and idempotent (sanitise(sanitise(x)) === sanitise(x)). */
export function sanitizeText(input: string): SanitiseResult {
  if (typeof input !== "string") throw new TypeError("sanitizeText expects a string");
  const rep = emptyReport(input.length);
  const frags: RemovedFragment[] = [];
  let s = replaceCounting(input, RX_LONE_SURROGATE, "�", (n) => (rep.loneSurrogatesReplaced += n));
  // Iterate to a fixed point: removing invisible characters can assemble a tag ("<\u200bscript>"), and decoding
  // an entity can produce one ("&lt;script&gt;").
  for (let i = 0; i < 8; i += 1) {
    const prev = s;
    s = charPass(htmlPass(s, rep, frags), rep);
    if (s === prev) break;
  }
  rep.outputLength = s.length;
  assertPlainText(s);
  return { text: s, report: rep, removedFragments: frags };
}

const DB_UNSAFE = [
  cls([[0x01, 0x08], 0x0b, 0x0c, [0x0e, 0x1f], 0x7f]),
  cls([[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], 0xfeff]),
];
/** Mirrors the database CHECK constraints; used as a defensive assertion and by tests. */
export function isDbPlainText(s: string): boolean {
  for (const rx of DB_UNSAFE) {
    rx.lastIndex = 0;
    if (rx.test(s)) return false;
  }
  RX_TAG.lastIndex = 0;
  const hasTag = RX_TAG.test(s);
  RX_TAG.lastIndex = 0;
  return !hasTag;
}

function assertPlainText(s: string): void {
  if (!isDbPlainText(s)) throw new Error("sanitiser invariant violated: output is not database-safe plain text");
}
