// Deterministic synthetic health-report generator (M2 "LISTEN" fixture).
//
// Produces NORMAL background variation plus deliberately PLANTED clusters and one decoy artifact.
// There is NO detector here: the ground truth exists so M3 can be evaluated against known answers.
// Everything is fictional. No real people, no real patient data.
import { Rng, addDays, dayOfWeek, deterministicUuid } from "./prng";
import { generateGeography, type SyntheticGeography } from "./geography";
import type {
  AgeBand, ReportSeverity, ReportType, SourceType, SyndromeCategory,
} from "../lib/supabase/database.types";

export const SYNTHETIC_BATCH = "m2-odisha-v1";
export const SYNTHETIC_SEED = 20261007;
export const START_DATE = "2026-06-15"; // India-local calendar date of day 0
export const DAYS = 90;

export interface SyntheticReport {
  client_submission_id: string;
  observed_at: string; // ISO, UTC
  source_type: SourceType;
  region_id: string;
  report_type: ReportType;
  syndrome: SyndromeCategory;
  symptom_codes: string[];
  severity: ReportSeverity;
  age_band: AgeBand;
  case_count: number;
  language: "en" | "hi" | "or";
  free_text: string | null;
  synthetic_batch: string;
}

export type GroundTruthKind = "true_cluster" | "decoy_reporting_artifact";

export interface GroundTruthEvent {
  id: string;
  kind: GroundTruthKind;
  description: string;
  syndrome: SyndromeCategory;
  region_codes: string[]; // block administrative codes
  start_date: string; // inclusive, India-local date
  end_date: string; // inclusive
  shape: "plateau" | "ramp" | "single_day_burst";
  multiplier: number | null; // peak rate multiplier on the baseline (null for the injected burst)
  injected_report_count: number; // extra reports attributable to the event (filled in by the generator)
}

interface EventSpec extends Omit<GroundTruthEvent, "injected_report_count"> {
  start_day: number; // 0-based index from START_DATE
  end_day: number;
  severity_shift: boolean;
  burst_reports?: number;
}

// Planted events. Day indices are 0-based from START_DATE.
const EVENTS: EventSpec[] = [
  {
    id: "P1", kind: "true_cluster", description: "Acute diarrhoeal illness surge in one block (clear, single-block plateau)",
    syndrome: "acute_diarrhoeal_illness", region_codes: ["SYN-OD-KHO-BAL"], start_day: 70, end_day: 77,
    shape: "plateau", multiplier: 7, severity_shift: true,
    start_date: "", end_date: "",
  },
  {
    id: "P2", kind: "true_cluster", description: "Fever-with-rash cluster spreading across two adjacent blocks",
    syndrome: "fever_with_rash", region_codes: ["SYN-OD-GAN-ASK", "SYN-OD-GAN-BHA"], start_day: 40, end_day: 48,
    shape: "plateau", multiplier: 6, severity_shift: true,
    start_date: "", end_date: "",
  },
  {
    id: "P3", kind: "true_cluster", description: "Sparse jaundice cluster (low counts: exercises small-cell suppression and low-sample confidence)",
    syndrome: "jaundice", region_codes: ["SYN-OD-PUR-NIM"], start_day: 58, end_day: 68,
    shape: "plateau", multiplier: 15, severity_shift: true,
    start_date: "", end_date: "",
  },
  {
    id: "P4", kind: "true_cluster", description: "Gradually ramping diarrhoeal cluster across two blocks of one district",
    syndrome: "acute_diarrhoeal_illness", region_codes: ["SYN-OD-CTC-ATH", "SYN-OD-CTC-BAR"], start_day: 28, end_day: 36,
    shape: "ramp", multiplier: 6, severity_shift: true,
    start_date: "", end_date: "",
  },
  {
    id: "D1", kind: "decoy_reporting_artifact",
    description: "One-day bulk import of fever reports (data-entry artifact, NOT a true signal)",
    syndrome: "fever", region_codes: ["SYN-OD-GAN-DIG"], start_day: 50, end_day: 50,
    shape: "single_day_burst", multiplier: null, severity_shift: false, burst_reports: 40,
    start_date: "", end_date: "",
  },
].map((e) => ({ ...e, start_date: addDays(START_DATE, e.start_day), end_date: addDays(START_DATE, e.end_day) })) as EventSpec[];

// Expected reports per block-day at block weight 1.0 (before seasonality/weekday/planting).
const BASE_RATE: ReadonlyArray<readonly [SyndromeCategory, number]> = [
  ["acute_diarrhoeal_illness", 0.9],
  ["fever", 1.1],
  ["fever_with_rash", 0.15],
  ["jaundice", 0.08],
  ["respiratory_illness", 0.8],
  ["other", 0.4],
];
const MONSOON_SENSITIVE = new Set<SyndromeCategory>(["acute_diarrhoeal_illness", "fever_with_rash", "jaundice"]);

const SYMPTOMS: Record<SyndromeCategory, readonly string[]> = {
  acute_diarrhoeal_illness: ["diarrhoea", "vomiting", "dehydration_signs", "abdominal_pain"],
  fever: ["fever", "headache", "body_ache"],
  fever_with_rash: ["fever", "rash"],
  jaundice: ["jaundice", "dark_urine", "fever"],
  respiratory_illness: ["cough", "breathlessness", "fever"],
  other: [],
  unknown: [],
};

const FREE_TEXT: Record<"en" | "hi" | "or", string> = {
  en: "Loose stools and vomiting for two days",
  hi: "दो दिन से दस्त और उल्टी",
  or: "ଦୁଇ ଦିନ ଧରି ଝାଡ଼ା ଏବଂ ବାନ୍ତି",
};

const SOURCE_WEIGHTS: ReadonlyArray<readonly [SourceType, number]> = [
  ["citizen", 0.55], ["health_facility", 0.18], ["clinician", 0.12], ["public_health_officer", 0.04],
  ["survey", 0.04], ["imported_dataset", 0.04], ["system_generated", 0.02], ["environmental", 0.01],
];
const SEVERITY_BASE: ReadonlyArray<readonly [ReportSeverity, number]> = [["mild", 0.6], ["moderate", 0.3], ["severe", 0.05], ["unknown", 0.05]];
const SEVERITY_SHIFTED: ReadonlyArray<readonly [ReportSeverity, number]> = [["mild", 0.35], ["moderate", 0.4], ["severe", 0.2], ["unknown", 0.05]];
const AGE_BASE: ReadonlyArray<readonly [AgeBand, number]> = [["age_0_4", 0.15], ["age_5_17", 0.2], ["age_18_44", 0.38], ["age_45_59", 0.15], ["age_60_plus", 0.1], ["age_unknown", 0.02]];
const AGE_YOUNG: ReadonlyArray<readonly [AgeBand, number]> = [["age_0_4", 0.3], ["age_5_17", 0.3], ["age_18_44", 0.25], ["age_45_59", 0.07], ["age_60_plus", 0.06], ["age_unknown", 0.02]];

function languageWeights(districtCode: string, source: SourceType): ReadonlyArray<readonly ["en" | "hi" | "or", number]> {
  if (source === "health_facility" || source === "clinician" || source === "public_health_officer") return [["en", 0.5], ["or", 0.4], ["hi", 0.1]];
  return districtCode === "GAN" ? [["or", 0.8], ["en", 0.15], ["hi", 0.05]] : [["or", 0.72], ["en", 0.2], ["hi", 0.08]];
}

/** Rate multiplier for one block/syndrome/day from planted events (1 = no event). */
function plantedMultiplier(day: number, blockCode: string, syndrome: SyndromeCategory): { mult: number; shifted: boolean } {
  let mult = 1;
  let shifted = false;
  for (const e of EVENTS) {
    if (e.kind !== "true_cluster" || e.syndrome !== syndrome || !e.region_codes.includes(blockCode)) continue;
    if (day < e.start_day || day > e.end_day) continue;
    const m = e.shape === "ramp"
      ? 1 + ((e.multiplier ?? 1) - 1) * ((day - e.start_day + 1) / (e.end_day - e.start_day + 1))
      : e.multiplier ?? 1;
    if (m > mult) mult = m;
    shifted = shifted || e.severity_shift;
  }
  return { mult, shifted };
}

function makeReport(
  rng: Rng, geo: SyntheticGeography, blockIdx: number, date: string, syndrome: SyndromeCategory,
  shifted: boolean, forcedSource: SourceType | null, index: number,
): SyntheticReport {
  const block = geo.blocks[blockIdx];
  const source = forcedSource ?? rng.weighted(SOURCE_WEIGHTS);
  const isFacility = source === "health_facility";
  const env = source === "environmental";
  const eff: SyndromeCategory = env ? "other" : syndrome;

  const pool = SYMPTOMS[eff];
  const symptoms = new Set<string>();
  if (pool.length > 0) {
    symptoms.add(pool[0]);
    const extra = rng.int(0, Math.min(2, pool.length - 1));
    for (let i = 0; i < extra; i++) symptoms.add(rng.pick(pool));
  }

  const language = rng.weighted(languageWeights(block.districtCode, source));
  const useLocality = rng.next() < 0.5;
  const regionId = useLocality ? rng.pick(block.localityIds) : block.region.id;
  // India-local 06:00-21:59 => same calendar date in UTC (IST = UTC+5:30), so IST date == `date`.
  const istMinutes = rng.int(360, 1319);
  const utcMinutes = istMinutes - 330;
  const hh = String(Math.floor(utcMinutes / 60)).padStart(2, "0");
  const mm = String(utcMinutes % 60).padStart(2, "0");

  return {
    client_submission_id: deterministicUuid("jansanket-report", `${SYNTHETIC_SEED}:${index}`),
    observed_at: `${date}T${hh}:${mm}:00.000Z`,
    source_type: source,
    region_id: regionId,
    report_type: isFacility ? "aggregate_count" : "individual_observation",
    syndrome: eff,
    symptom_codes: [...symptoms].sort(),
    severity: env ? "unknown" : rng.weighted(shifted ? SEVERITY_SHIFTED : SEVERITY_BASE),
    age_band: env ? "age_unknown" : rng.weighted(eff === "acute_diarrhoeal_illness" || eff === "fever_with_rash" ? AGE_YOUNG : AGE_BASE),
    case_count: isFacility ? Math.min(8, 1 + rng.poisson(1.2)) : 1,
    language,
    free_text: source === "citizen" && eff === "acute_diarrhoeal_illness" && rng.next() < 0.1 ? FREE_TEXT[language] : null,
    synthetic_batch: SYNTHETIC_BATCH,
  };
}

export interface SyntheticDataset {
  geography: SyntheticGeography;
  reports: SyntheticReport[];
  groundTruth: GroundTruthEvent[];
  startDate: string;
  endDate: string;
}

export function generateSyntheticDataset(): SyntheticDataset {
  const geo = generateGeography();
  const reports: SyntheticReport[] = [];
  const injected = new Map<string, number>();
  let index = 0;

  for (let day = 0; day < DAYS; day++) {
    const date = addDays(START_DATE, day);
    const dow = dayOfWeek(date);
    const weekday = dow === 0 ? 0.7 : dow === 1 ? 1.15 : 1;
    // Slow monsoon-like swing; integer-free but deterministic on V8.
    const swing = 1 + 0.3 * Math.sin((2 * Math.PI * day) / DAYS);

    geo.blocks.forEach((block, blockIdx) => {
      const code = block.region.administrative_code;
      for (const [syndrome, base] of BASE_RATE) {
        const rng = new Rng(`${SYNTHETIC_SEED}|cell|${day}|${code}|${syndrome}`);
        const { mult, shifted } = plantedMultiplier(day, code, syndrome);
        const lambda = base * block.weight * weekday * (MONSOON_SENSITIVE.has(syndrome) ? swing : 1) * mult;
        const n = rng.poisson(lambda);
        for (let i = 0; i < n; i++) {
          reports.push(makeReport(rng, geo, blockIdx, date, syndrome, shifted, null, index++));
        }
        if (mult > 1) {
          const baselineN = base * block.weight * weekday * (MONSOON_SENSITIVE.has(syndrome) ? swing : 1);
          const ev = EVENTS.find((e) => e.kind === "true_cluster" && e.syndrome === syndrome && e.region_codes.includes(code) && day >= e.start_day && day <= e.end_day);
          if (ev) injected.set(ev.id, (injected.get(ev.id) ?? 0) + Math.max(0, n - Math.round(baselineN)));
        }
      }
    });
  }

  // Decoy: bulk-import artifact (single day, single block, imported_dataset source, severity unknown).
  for (const e of EVENTS.filter((x) => x.kind === "decoy_reporting_artifact")) {
    const blockIdx = geo.blocks.findIndex((b) => e.region_codes.includes(b.region.administrative_code));
    const date = addDays(START_DATE, e.start_day);
    const rng = new Rng(`${SYNTHETIC_SEED}|decoy|${e.id}`);
    for (let i = 0; i < (e.burst_reports ?? 0); i++) {
      const r = makeReport(rng, geo, blockIdx, date, e.syndrome, false, "imported_dataset", index++);
      reports.push({ ...r, severity: "unknown", free_text: null });
    }
    injected.set(e.id, e.burst_reports ?? 0);
  }

  const groundTruth: GroundTruthEvent[] = EVENTS.map(({ start_day: _s, end_day: _e, severity_shift: _v, burst_reports: _b, ...rest }) => ({
    ...rest,
    injected_report_count: injected.get(rest.id) ?? 0,
  }));

  return { geography: geo, reports, groundTruth, startDate: START_DATE, endDate: addDays(START_DATE, DAYS - 1) };
}

/** Canonical one-line-per-report serialisation (fixed key order) used for the reproducibility hash. */
export function canonicalReportLine(r: SyntheticReport): string {
  return JSON.stringify([
    r.client_submission_id, r.observed_at, r.source_type, r.region_id, r.report_type, r.syndrome,
    r.symptom_codes, r.severity, r.age_band, r.case_count, r.language, r.free_text, r.synthetic_batch,
  ]);
}
