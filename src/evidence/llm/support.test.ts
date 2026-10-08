// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkSupport, dateSupported, extractDates, extractEntities, extractNumbers, extractTerms, lexicalCoverage } from "./support";

describe("dates", () => {
  it("recognises ISO, day-month-year, month-day-year, month-year and bare years, normalised", () => {
    expect(extractDates("on 2025-09-07 and 7 September 2025 and Sept 7, 2025 and March 2024 and in 2019").dates.sort()).toEqual(["2019", "2024-03", "2025-09-07", "2025-09-07", "2025-09-07"].sort());
  });
  it("blanks dates out of the text so their digits are not also counted as numbers", () => {
    expect(extractNumbers("reported on 2025-09-07 by 12 clinics")).toEqual(["12"]);
    expect(extractNumbers("during 2019")).toEqual([]);
  });
  it("a date is supported by an equal date or by a more specific date inside the period it names", () => {
    const s = new Set(["2025-09-07", "2024-03-15"]);
    expect(dateSupported("2025-09-07", s)).toBe(true);
    expect(dateSupported("2025-09", s)).toBe(true);
    expect(dateSupported("2025", s)).toBe(true);
    expect(dateSupported("2025-09-08", s)).toBe(false);
    expect(dateSupported("2025-10", s)).toBe(false);
    expect(dateSupported("2019", s)).toBe(false);
  });
});

describe("numbers", () => {
  it("extracts digits, decimals, thousands separators and percentages as plain numeric values", () => {
    expect(extractNumbers("1,200 reports, 3.50 days, 40% and 40 per cent")).toEqual(["1200", "3.5", "40"]);
  });
  it("splits ranges and ignores digits stuck to letters (H5N1, N1)", () => {
    expect(extractNumbers("24-48 hours")).toEqual(["24", "48"]);
    expect(extractNumbers("the H5N1 strain")).toEqual([]);
  });
  it("understands spelled-out numbers, so 'seventy-two hours' and '72 hours' agree", () => {
    expect(extractNumbers("within seventy-two hours")).toEqual(["72"]);
    expect(extractNumbers("within seventy two hours")).toEqual(["72"]);
    expect(extractNumbers("twenty four hours and three days")).toEqual(["24", "3"]);
    expect(extractNumbers("one of the documents")).toEqual([]); // "one" alone is a pronoun, not a count
  });
});

describe("named entities", () => {
  it("finds acronyms and runs of capitalised words, joined across of/for/and", () => {
    expect(extractEntities("The Ministry of Health and WHO issued guidance for Odisha State.")).toEqual(["Ministry of Health", "Odisha State", "WHO"].sort());
  });
  it("ignores ordinary sentence-initial words, months, and citation tokens", () => {
    expect(extractEntities("Passage [E1] states that reports are filed. The guidance says so. In March it changed.")).toEqual([]);
  });
  it("keeps an uncommon sentence-initial capitalised word, because it could be a name", () => {
    expect(extractEntities("Pfizer sent samples.")).toEqual(["Pfizer"]);
  });
  it("strips possessives and surrounding punctuation", () => {
    expect(extractEntities('The "Khordha\'s" district, (Ganjam) and Puri.')).toEqual(["Ganjam", "Khordha", "Puri"]);
  });
});

describe("controlled terminology", () => {
  it("finds disease names, outbreak words and symptom stems", () => {
    expect(extractTerms("Cholera and typhoid, an outbreak, with diarrhoea and fever")).toEqual(["cholera", "diarrh", "fever", "outbreak", "typhoid"].sort());
    expect(extractTerms("outbreaks and epidemics")).toEqual(["epidemic", "outbreak"]);
  });
});

describe("support is checked against the verified anchors and the signal facts only", () => {
  const facts = "syndrome: acute diarrhoeal illness\nplace: Balianta, Khordha, Odisha\nwindow: 2025-08-31 to 2025-09-07";
  const anchor = "report any cluster of acute watery diarrhoea to the district officer within 24 hours";

  it("passes a statement whose numbers, dates, names and terms are all present", () => {
    const r = checkSupport("Reports from Balianta in Khordha should reach the district officer within 24 hours during 2025.", [anchor, facts]);
    expect(r.numbers.unsupported).toEqual([]);
    expect(r.dates.unsupported).toEqual([]);
    expect(r.entities.unsupported).toEqual([]);
  });

  it("flags a number that the anchors do not contain, and accepts the same value spelled out", () => {
    expect(checkSupport("within 72 hours", [anchor, facts]).numbers.unsupported).toEqual(["72"]);
    expect(checkSupport("within twenty-four hours", [anchor, facts]).numbers.unsupported).toEqual([]);
  });

  it("flags a date that is not in the anchors or the facts", () => {
    expect(checkSupport("updated on 14 March 2019", [anchor, facts]).dates.unsupported).toEqual(["2019-03-14"]);
    expect(checkSupport("window ending 2025-09-07", [anchor, facts]).dates.unsupported).toEqual([]);
  });

  it("flags a name that is not supported, and needs every word of a multi-word name", () => {
    expect(checkSupport("according to the Ministry of Magic", [anchor, facts]).entities.unsupported).toEqual(["Ministry of Magic"]);
    expect(checkSupport("the Ministry of Health", ["the ministry of health issued this note", facts]).entities.unsupported).toEqual([]);
    expect(checkSupport("the Ministry of Health", ["the health office", facts]).entities.unsupported).toEqual(["Ministry of Health"]);
  });

  it("requires an acronym to match in its own case", () => {
    expect(checkSupport("as WHO describes", ["those who report", facts]).entities.unsupported).toEqual(["WHO"]);
    expect(checkSupport("as WHO describes", ["the WHO note", facts]).entities.unsupported).toEqual([]);
  });

  it("flags terminology the anchors and facts do not use", () => {
    expect(checkSupport("related to typhoid", [anchor, facts]).terms.unsupported).toEqual(["typhoid"]);
    expect(checkSupport("an outbreak", [anchor, facts]).terms.unsupported).toEqual(["outbreak"]);
    expect(checkSupport("watery diarrhoea cases", [anchor, facts]).terms.unsupported).toEqual([]);
    expect(checkSupport("jaundice cases", [anchor, facts]).terms.unsupported).toEqual(["jaundice"]);
  });

  it("uses no outside knowledge: a true but unsupported statement is still unsupported", () => {
    const r = checkSupport("The WHO recommends 2 litres.", ["the officer within 24 hours", facts]);
    expect(r.numbers.unsupported).toEqual(["2"]);
    expect(r.entities.unsupported).toEqual(["WHO"]);
  });
});

describe("lexical coverage is only a recorded signal", () => {
  it("is the share of content words found in the cited passages", () => {
    expect(lexicalCoverage("district officer reviews reports", ["the district officer reviews all reports promptly"])).toBe(1);
    expect(lexicalCoverage("district officer reviews reports", ["unrelated text about weather"])).toBe(0);
    expect(lexicalCoverage("of the and", ["anything"])).toBe(1); // nothing to measure
  });
});
