// Deterministic support checks. A generated statement may contain a number, a date, a named entity or a piece of
// controlled terminology (a disease or outbreak word, a symptom word) ONLY if that item also appears in the statement's own
// verified anchors or in the approved signal facts. No model, no similarity: extraction is conservative pattern matching,
// and support is substring / word-set presence in text the system already trusts.
//
// Known limits (stated, not hidden): extraction is heuristic. It can miss an unusual name or a spelled-out number such as
// "one in ten", and it can flag a harmless capitalised word that is not in the stop list. It errs toward refusing.
import { DISEASE_RE, OUTBREAK_RE } from "./forbidden";
import { foldForScan } from "./normalize";

const CITATION = /\[E\d+\]/g;

// ---------------------------------------------------------------- dates
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNumber = (w: string): number => {
  const i = MONTH_NAMES.indexOf(w);
  return i >= 0 ? i + 1 : (MONTH_ABBR[w] ?? 0);
};
const MONTH = `(?:${[...MONTH_NAMES, ...Object.keys(MONTH_ABBR)].sort((a, b) => b.length - a.length).join("|")})`;
const two = (n: number | string): string => String(n).padStart(2, "0");

/** Dates found in a text, normalised to YYYY-MM-DD, YYYY-MM or YYYY; and the text with those dates blanked out. */
export function extractDates(text: string): { dates: string[]; rest: string } {
  let rest = foldForScan(text).replace(/\[e\d+\]/g, " ");
  const dates: string[] = [];
  const take = (re: RegExp, f: (m: RegExpMatchArray) => string): void => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      dates.push(f(m));
      return " ";
    });
  };
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => `${m[1]}-${m[2]}-${m[3]}`);
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?,?\\s+(\\d{4})\\b`, "g"), (m) => `${m[3]}-${two(monthNumber(m[2]))}-${two(m[1])}`);
  take(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g"), (m) => `${m[3]}-${two(monthNumber(m[1]))}-${two(m[2])}`);
  take(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{4})\\b`, "g"), (m) => `${m[2]}-${two(monthNumber(m[1]))}`);
  take(/\b(1[89]\d{2}|20\d{2})\b/g, (m) => m[1]);
  return { dates, rest };
}

/** A claim date is supported by an equal date, or by a more specific date inside the period it names. */
export function dateSupported(claim: string, support: ReadonlySet<string>): boolean {
  if (support.has(claim)) return true;
  if (claim.length === 7 || claim.length === 4) return [...support].some((s) => s.startsWith(claim));
  return false;
}

// ---------------------------------------------------------------- numbers
const UNIT_WORDS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000,
};
const TENS_WORDS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const NUMBER_WORD = new RegExp(`\\b(?:(${Object.keys(TENS_WORDS).join("|")})(?:[- ](${Object.keys(ONES).join("|")}))?|(${Object.keys(UNIT_WORDS).join("|")}))\\b`, "g");

const canonicalNumber = (s: string): string => String(Number(s.replace(/,(?=\d{3}(?!\d))/g, "")));

/** Numeric values in a text: digits (thousands separators handled), percentages, spelled-out numbers two..nine hundred etc. Dates excluded. */
export function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  const { rest } = extractDates(text);
  const body = rest.replace(/per ?cent/g, "%");
  for (const m of body.matchAll(/(?<![\p{L}\d])\d+(?:,\d{3})*(?:\.\d+)?/gu)) out.add(canonicalNumber(m[0]));
  for (const m of body.matchAll(NUMBER_WORD)) {
    if (m[1]) out.add(String(TENS_WORDS[m[1]] + (m[2] ? ONES[m[2]] : 0)));
    else out.add(String(UNIT_WORDS[m[3]]));
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- named entities
const CONNECTORS = new Set(["of", "for", "the", "de", "da", "di", "in", "on", "to"]);
const STOP_STARTERS = new Set(
  ("a an the this that these those it its they their them he she his her we our you your i me my there here then than thus so but and or nor if when while where which who whom whose what why how " +
    "in on at by for with from to of as into onto upon over under between among about after before during since until through within without across against per via " +
    "both each every some several many few most more less no not none all any another other such same also only just even still yet both either neither one two three " +
    "passage passages evidence statement statements guidance guideline guidelines document documents source sources report reports reporting case cases definition definitions " +
    "signal signals cluster clusters data information text texts section sections table figure note notes summary context terms term review surveillance investigation " +
    "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday " +
    "first second third next previous following earlier later further additionally however therefore overall generally typically").split(" "),
);
const stripToken = (t: string): string =>
  t.replace(/^[\p{Ps}\p{Pi}"'[]+/u, "").replace(/[\p{Pe}\p{Pf}"'\].,;:!?]+$/u, "").replace(/['\p{Pf}]s$/u, "");
const isCapitalised = (t: string): boolean => /^\p{Lu}/u.test(t) && t.length >= 2;
const isAcronym = (t: string): boolean => /^\p{Lu}{2,}[\p{Lu}\d]*$/u.test(t);

/** Named entities: acronyms and runs of capitalised words (with of/for/and linking them). Sentence-initial common words are ignored. */
export function extractEntities(text: string): string[] {
  const out = new Set<string>();
  const cleaned = text.normalize("NFC").replace(CITATION, " ");
  for (const sentence of cleaned.split(/(?<=[.!?])\s+|\n+|[:;]\s+/u)) {
    const tokens = sentence.split(/\s+/u).map(stripToken).filter(Boolean);
    let run: string[] = [];
    const flush = (): void => {
      let words = run;
      while (words.length && !isAcronym(words[0]) && STOP_STARTERS.has(words[0].toLowerCase())) words = words.slice(1);
      while (words.length && CONNECTORS.has(words[words.length - 1].toLowerCase())) words = words.slice(0, -1);
      if (words.length) out.add(words.join(" "));
      run = [];
    };
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      const next = tokens[i + 1];
      if (isCapitalised(t) || isAcronym(t)) run.push(t);
      else if (run.length && CONNECTORS.has(t.toLowerCase()) && next && isCapitalised(next)) run.push(t);
      else if (run.length) flush();
    }
    if (run.length) flush();
  }
  return [...out].sort();
}

/** Words of a text (letters and digits), lower case. */
const wordsOf = (s: string): Set<string> => new Set(foldForScan(s).match(/[\p{L}\p{N}]+/gu) ?? []);

/** An acronym must appear in the support text with the same capitals, as a whole token. */
const acronymPresent = (acronym: string, text: string): boolean => text.split(/[^\p{L}\p{N}]+/u).includes(acronym);

/** Is a named entity present in the support text? Acronyms must match case; other names need every word of the name present. */
export function entitySupported(entity: string, supportOriginal: string, supportWords: ReadonlySet<string>): boolean {
  const tokens = entity.split(/\s+/u).filter((w) => !CONNECTORS.has(w.toLowerCase()));
  return tokens.length > 0 && tokens.every((w) => (isAcronym(w) ? acronymPresent(w, supportOriginal) : supportWords.has(w.toLowerCase())));
}

// ---------------------------------------------------------------- controlled terminology
const SYMPTOM_STEMS = ["diarrh", "vomit", "fever", "jaundice", "rash", "cough", "respirat", "dehydrat"];

/** Disease names, outbreak words and symptom words in a text, as lower-case keys ("outbreak", "diarrh", "cholera", ...). */
export function extractTerms(text: string): string[] {
  const folded = foldForScan(text).replace(/\[e\d+\]/g, " ");
  const out = new Set<string>();
  for (const m of folded.matchAll(DISEASE_RE)) out.add(m[0]);
  for (const m of folded.matchAll(OUTBREAK_RE)) out.add(m[0].replace(/s$/, ""));
  for (const stem of SYMPTOM_STEMS) if (folded.includes(stem)) out.add(stem);
  return [...out].sort();
}
const termSupported = (term: string, foldedSupport: string): boolean => (SYMPTOM_STEMS.includes(term) ? foldedSupport.includes(term) : new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(foldedSupport));

// ---------------------------------------------------------------- combined check
export interface SupportReport {
  numbers: { checked: number; unsupported: string[] };
  dates: { checked: number; unsupported: string[] };
  entities: { checked: number; unsupported: string[] };
  terms: { checked: number; unsupported: string[] };
}

/** Check one piece of model-written text against the texts that may support it (its verified anchors and the signal facts). */
export function checkSupport(claim: string, supportTexts: readonly string[]): SupportReport {
  const supportOriginal = supportTexts.join("\n");
  const supportFolded = foldForScan(supportOriginal);
  const supportWords = wordsOf(supportOriginal);
  const supportDates = new Set(extractDates(supportOriginal).dates);
  const supportNumbers = new Set(extractNumbers(supportOriginal));

  const claimDates = [...new Set(extractDates(claim).dates)];
  const claimNumbers = extractNumbers(claim);
  const claimEntities = extractEntities(claim);
  const claimTerms = extractTerms(claim);
  return {
    numbers: { checked: claimNumbers.length, unsupported: claimNumbers.filter((n) => !supportNumbers.has(n)) },
    dates: { checked: claimDates.length, unsupported: claimDates.filter((d) => !dateSupported(d, supportDates)) },
    entities: { checked: claimEntities.length, unsupported: claimEntities.filter((e) => !entitySupported(e, supportOriginal, supportWords)) },
    terms: { checked: claimTerms.length, unsupported: claimTerms.filter((t) => !termSupported(t, supportFolded)) },
  };
}

// ---------------------------------------------------------------- lexical coverage (reported, never used as proof)
const FILLER = new Set(
  ("that this with from have has been were was are the and for not but can may will would should could their there which what when where about into than then also only more most some such these those other between within without under over after before during while each both either states state says said describes described passage passages source sources guidance document documents report reports").split(" "),
);

/** Share of the statement's content words that occur in the cited passages. Recorded for audit and evaluation; it proves nothing. */
export function lexicalCoverage(claim: string, passageTexts: readonly string[]): number {
  const claimWords = [...wordsOf(claim.replace(CITATION, " "))].filter((w) => w.length >= 4 && !FILLER.has(w) && !/^\d+$/.test(w));
  if (claimWords.length === 0) return 1;
  const have = wordsOf(passageTexts.join(" "));
  return Math.round((claimWords.filter((w) => have.has(w)).length / claimWords.length) * 1000) / 1000;
}
