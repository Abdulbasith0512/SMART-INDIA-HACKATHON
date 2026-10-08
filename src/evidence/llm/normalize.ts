// Text normalisation used by the validators. Two different normalisations, kept apart on purpose:
//
//   anchors   the ONLY normalisation allowed when proving a quote is a substring of a passage: Unicode NFC and
//             whitespace collapsing. Case, punctuation and every other character must match exactly. No similarity.
//   scanning  an aggressive fold (NFKC, lower case, invisible characters removed) used ONLY to detect forbidden
//             wording, so that obfuscation cannot hide it. Scanning never decides that a quote is genuine.

/** Anchor quotes must be at least this long (after normalisation) and this many words, so "the" cannot anchor a claim. */
export const MIN_ANCHOR_CHARS = 12;
export const MIN_ANCHOR_WORDS = 3;

const WHITESPACE = /\p{White_Space}+/gu;

/** NFC + runs of any Unicode whitespace become one space + trimmed. This is the whole of the "approved" anchor normalisation. */
export const normaliseForAnchor = (s: string): string => s.normalize("NFC").replace(WHITESPACE, " ").trim();

export type AnchorStatus = "ok" | "too_short" | "not_verbatim";

/** Is `quote` (after the approved normalisation) a contiguous substring of `passage` (after the same normalisation)? */
export function anchorStatus(passage: string, quote: string): AnchorStatus {
  const q = normaliseForAnchor(quote);
  if (q.length < MIN_ANCHOR_CHARS || q.split(" ").length < MIN_ANCHOR_WORDS) return "too_short";
  return normaliseForAnchor(passage).includes(q) ? "ok" : "not_verbatim";
}

// Control (other than newline, carriage return, tab), format (zero width, bidi), private use, surrogate, unassigned, and
// line / paragraph separators. None of these belongs in an English sentence.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u;
const HIDDEN_ALL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/gu;
const ORDINARY_WHITESPACE = /[\n\r\t]/g;

export const hasHiddenCharacters = (s: string): boolean => HIDDEN.test(s.replace(ORDINARY_WHITESPACE, " "));
export const stripHiddenCharacters = (s: string): string => s.replace(ORDINARY_WHITESPACE, " ").replace(HIDDEN_ALL, "");

/** Any letter that is not Latin script. Explanations are English; this also blocks look-alike letters hiding a keyword. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
export const hasNonLatinLetters = (s: string): boolean => NON_LATIN_LETTER.test(s);

/** Fold for pattern scanning only. */
export const foldForScan = (s: string): string => stripHiddenCharacters(s).normalize("NFKC").toLowerCase().replace(WHITESPACE, " ").trim();
