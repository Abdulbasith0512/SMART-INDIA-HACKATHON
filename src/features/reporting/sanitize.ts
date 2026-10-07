// Free-text sanitisation. Heuristic redaction of direct identifiers; it can NOT guarantee that
// free text is PII-free (names and addresses cannot be reliably detected). That is why free text
// is optional, short, never sent to an LLM in M2, and cleared by the retention job.
import { MAX_FREE_TEXT_LENGTH } from "./contracts";

// Devanagari (U+0966-096F) and Odia (U+0B66-0B6F) digits -> ASCII, so phone numbers written in
// local numerals are caught by the same rules. Fullwidth digits too.
function toAsciiDigits(s: string): string {
  return s.replace(/[०-९୦-୯０-９]/g, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff10) return String(cp - 0xff10);
    if (cp >= 0x0b66) return String(cp - 0x0b66);
    return String(cp - 0x0966);
  });
}

// Control chars, zero-width / bidi marks, line & paragraph separators, BOM. Built from escapes on purpose.
// eslint-disable-next-line no-control-regex
const CONTROL_AND_INVISIBLE = new RegExp("[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]", "g");
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
// Same shape the database CHECK rejects: 10+ digits with optional single separators.
export const LONG_DIGIT_RUN = /(\d[\s.-]?){10,}/g;

export const RESIDUAL_PII = (text: string): boolean =>
  /(\d[\s.-]?){10,}/.test(text) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);

export interface SanitizedText {
  text: string | null;
  redactions: number;
}

export function sanitizeFreeText(raw: string | null | undefined): SanitizedText {
  if (raw == null) return { text: null, redactions: 0 };
  let redactions = 0;
  const bump = (replacement: string) => () => {
    redactions++;
    return replacement;
  };

  let t = toAsciiDigits(raw.normalize("NFC"))
    .replace(CONTROL_AND_INVISIBLE, " ");
  t = t.replace(EMAIL, bump("[email removed]"));
  t = t.replace(URL, bump("[link removed]"));
  t = t.replace(LONG_DIGIT_RUN, (match) => {
    redactions++;
    // The pattern may swallow one trailing separator; keep it so words are not glued together.
    return "[number removed]" + (/[\s.-]$/.test(match) ? match.slice(-1) : "");
  });
  t = t.replace(/\s+/g, " ").trim();

  if (t.length === 0) return { text: null, redactions };
  return { text: t, redactions };
}

export const exceedsMaxLength = (text: string | null): boolean => text !== null && text.length > MAX_FREE_TEXT_LENGTH;
