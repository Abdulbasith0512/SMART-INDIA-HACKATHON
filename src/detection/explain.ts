// Deterministic explanation text. Pure template: no LLM, no free-form generation.
// Wording rule: a detected pattern is an "emerging signal requiring verification", never a "confirmed outbreak"
// and never a diagnosis.
export const SIGNAL_PREFIX = "Emerging signal requiring verification:";
export const DISCLAIMER = "This is a statistical flag, not a confirmed outbreak or a diagnosis. Human verification required.";

const LABELS: Record<string, string> = {
  acute_diarrhoeal_illness: "acute diarrhoeal illness",
  fever: "fever",
  fever_with_rash: "fever-with-rash",
  jaundice: "jaundice",
  respiratory_illness: "respiratory illness",
};
export const syndromeLabel = (s: string): string => LABELS[s] ?? s.replace(/_/g, " ");

export interface ExplainInput {
  syndrome: string;
  placeLabel: string; // e.g. "Aska" or "Ganjam district (Aska, Bhanjanagar)"
  windowDays: number;
  fromDate: string;
  toDate: string;
  observed: number;
  expected: number;
  ratio: number;
  elevatedDays: number;
  sourceTypes: number;
}

export function explainSignal(x: ExplainInput): string {
  const expected = x.expected < 0.1 ? "<0.1" : x.expected.toFixed(1);
  const parts = [
    `${SIGNAL_PREFIX} elevated ${syndromeLabel(x.syndrome)} observations in ${x.placeLabel} over the last ${x.windowDays} days (${x.fromDate} to ${x.toDate}).`,
    `${x.observed} reports vs about ${expected} expected (x${x.ratio.toFixed(1)}), elevated on ${x.elevatedDays} of ${x.windowDays} days, from ${x.sourceTypes} source type${x.sourceTypes === 1 ? "" : "s"}.`,
    DISCLAIMER,
  ];
  return parts.join(" ");
}

/**
 * Wording safety check used by tests and by the persistence layer:
 * the text must carry the standard prefix and disclaimer, and once those are removed it must not
 * contain outbreak/diagnosis/epidemic language.
 */
export function isSafeExplanation(text: string): boolean {
  if (!text.startsWith(SIGNAL_PREFIX) || !text.includes(DISCLAIMER)) return false;
  const rest = text.replace(SIGNAL_PREFIX, "").replace(DISCLAIMER, "");
  return !/outbreak|diagnos|epidemic|pandemic|confirmed|probability|likelihood of/i.test(rest);
}
