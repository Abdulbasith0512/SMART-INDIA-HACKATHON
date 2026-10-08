// @vitest-environment node
import { describe, expect, it } from "vitest";
import { anchorStatus, foldForScan, hasHiddenCharacters, hasNonLatinLetters, MIN_ANCHOR_CHARS, MIN_ANCHOR_WORDS, normaliseForAnchor, stripHiddenCharacters } from "./normalize";

const ZWSP = String.fromCodePoint(0x200b);
const BIDI = String.fromCodePoint(0x202e);
const NBSP = String.fromCodePoint(0x00a0);
const DEVANAGARI = String.fromCodePoint(0x0928, 0x092e, 0x0938, 0x094d, 0x0924, 0x0947);
const CYRILLIC_O = String.fromCodePoint(0x043e);

describe("approved anchor normalisation is NFC and whitespace only", () => {
  const passage = "Report any cluster of acute watery diarrhoea to the district surveillance officer within 24 hours.";

  it("collapses runs of any whitespace, including newlines and non-breaking spaces, and trims", () => {
    expect(normaliseForAnchor(`  a${NBSP}${NBSP}b \n\t c  `)).toBe("a b c");
    expect(anchorStatus(passage, "any cluster\nof   acute watery diarrhoea")).toBe("ok");
    expect(anchorStatus(`any cluster of${NBSP}acute watery`, "any cluster of acute watery")).toBe("ok");
  });

  it("treats composed and decomposed accents as the same text (NFC)", () => {
    const composed = "café menu list";
    const decomposed = "café menu list";
    expect(normaliseForAnchor(decomposed)).toBe(normaliseForAnchor(composed));
    expect(anchorStatus(composed, decomposed)).toBe("ok");
  });

  it("is case-sensitive and punctuation-exact: nothing else is normalised", () => {
    expect(anchorStatus(passage, "any cluster of ACUTE watery diarrhoea")).toBe("not_verbatim");
    expect(anchorStatus(passage, "district surveillance officer within 24 hours")).toBe("ok");
    expect(anchorStatus(passage, "district surveillance officer, within 24 hours")).toBe("not_verbatim");
    expect(anchorStatus(passage, "cluster of acute watery diarrhoeas")).toBe("not_verbatim");
  });

  it("does not accept a paraphrase, a reordering, or words from two different places joined together", () => {
    expect(anchorStatus(passage, "report a diarrhoea cluster to the officer")).toBe("not_verbatim");
    expect(anchorStatus(passage, "within 24 hours any cluster of acute")).toBe("not_verbatim");
    expect(anchorStatus(passage, "Report any cluster officer within 24 hours")).toBe("not_verbatim");
  });

  it("refuses an anchor that is too short to prove anything", () => {
    expect(MIN_ANCHOR_CHARS).toBe(12);
    expect(MIN_ANCHOR_WORDS).toBe(3);
    expect(anchorStatus(passage, "cluster")).toBe("too_short");
    expect(anchorStatus(passage, "any cluster")).toBe("too_short"); // 2 words
    expect(anchorStatus(passage, "a b c d e f")).toBe("too_short"); // under 12 characters
    expect(anchorStatus(passage, "any cluster of")).toBe("ok");
    expect(anchorStatus(passage, "   ")).toBe("too_short");
  });

  it("matches only inside the one passage it is given", () => {
    expect(anchorStatus("alpha beta gamma delta", "gamma delta epsilon zeta")).toBe("not_verbatim");
  });
});

describe("hidden and non-Latin characters", () => {
  it("detects zero-width, bidi, control and private-use characters, but not ordinary whitespace", () => {
    expect(hasHiddenCharacters(`ab${ZWSP}cd`)).toBe(true);
    expect(hasHiddenCharacters(`ab${BIDI}cd`)).toBe(true);
    expect(hasHiddenCharacters(`ab${String.fromCodePoint(0x0007)}cd`)).toBe(true);
    expect(hasHiddenCharacters(`ab${String.fromCodePoint(0xe000)}cd`)).toBe(true);
    expect(hasHiddenCharacters("plain text\nwith a newline\tand a tab\r\n")).toBe(false);
    expect(hasHiddenCharacters(`non${NBSP}breaking`)).toBe(false);
  });

  it("strips hidden characters for scanning", () => {
    expect(stripHiddenCharacters(`ig${ZWSP}nore`)).toBe("ignore");
  });

  it("detects letters outside Latin script (including look-alikes) and allows accents, digits and punctuation", () => {
    expect(hasNonLatinLetters(DEVANAGARI)).toBe(true);
    expect(hasNonLatinLetters(`out${CYRILLIC_O}reak`)).toBe(true);
    expect(hasNonLatinLetters("café über 24-hour (about 40%).")).toBe(false);
  });

  it("folds text for scanning: NFKC, lower case, hidden characters removed, whitespace collapsed", () => {
    expect(foldForScan(`  IG${ZWSP}NORE
   PREVIOUS  `)).toBe("ignore previous");
    expect(foldForScan(`Out${ZWSP}break`)).toBe("outbreak");
    expect(foldForScan("ＡＢＣ")).toBe("abc"); // full-width letters fold to ASCII
  });
});
