// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Rng, addDays, deterministicUuid } from "./prng";
import {
  DAYS, START_DATE, SYNTHETIC_BATCH, canonicalReportLine, generateSyntheticDataset, type SyntheticReport,
} from "./generate";
import { generateGeography } from "./geography";

const ds = generateSyntheticDataset();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const SYMPTOM_VOCAB = new Set([
  "diarrhoea", "vomiting", "dehydration_signs", "abdominal_pain", "fever", "headache", "body_ache",
  "rash", "jaundice", "dark_urine", "cough", "breathlessness",
]);

describe("determinism and reproducibility", () => {
  it("PRNG and UUID derivation are pure functions of their inputs", () => {
    const a = new Rng("k"), b = new Rng("k"), c = new Rng("other");
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
    expect(deterministicUuid("ns", "x")).toBe(deterministicUuid("ns", "x"));
    expect(deterministicUuid("ns", "x")).not.toBe(deterministicUuid("ns", "y"));
    expect(deterministicUuid("ns", "x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
  });

  it("two independent generations are byte-identical", () => {
    const again = generateSyntheticDataset();
    expect(again.reports.map(canonicalReportLine)).toEqual(ds.reports.map(canonicalReportLine));
    expect(JSON.stringify(again.geography.regions)).toBe(JSON.stringify(ds.geography.regions));
    expect(JSON.stringify(again.groundTruth)).toBe(JSON.stringify(ds.groundTruth));
  });

  it("matches the committed manifest (run `npm run synth:export` if the generator changed on purpose)", () => {
    const m = JSON.parse(readFileSync(join(process.cwd(), "data", "synthetic", `${SYNTHETIC_BATCH}.manifest.json`), "utf8"));
    expect(m.report_count).toBe(ds.reports.length);
    expect(m.region_count).toBe(ds.geography.regions.length);
    expect(m.reports_sha256).toBe(sha(ds.reports.map(canonicalReportLine).join("\n")));
    expect(m.regions_sha256).toBe(sha(JSON.stringify(ds.geography.regions)));
    expect(m.ground_truth_sha256).toBe(sha(JSON.stringify(ds.groundTruth)));
    const gt = JSON.parse(readFileSync(join(process.cwd(), "data", "synthetic", `${SYNTHETIC_BATCH}.ground-truth.json`), "utf8"));
    expect(gt).toEqual(JSON.parse(JSON.stringify(ds.groundTruth)));
  });
});

describe("synthetic Odisha geography", () => {
  const geo = generateGeography();
  it("has the expected hierarchy and unique deterministic ids", () => {
    const count = (t: string) => geo.regions.filter((r) => r.region_type === t).length;
    expect([count("country"), count("state"), count("district"), count("block"), count("locality")]).toEqual([1, 1, 4, 16, 32]);
    expect(new Set(geo.regions.map((r) => r.id)).size).toBe(geo.regions.length);
    expect(new Set(geo.regions.map((r) => r.administrative_code)).size).toBe(geo.regions.length);
  });

  it("lists parents before children and each region has the correct parent level", () => {
    const order = new Map(geo.regions.map((r, i) => [r.id, i]));
    const byId = new Map(geo.regions.map((r) => [r.id, r]));
    const expectParent: Record<string, string | null> = { country: null, state: "country", district: "state", block: "district", locality: "block" };
    for (const r of geo.regions) {
      if (r.parent_region_id) {
        expect(order.get(r.parent_region_id)!).toBeLessThan(order.get(r.id)!);
        expect(byId.get(r.parent_region_id)!.region_type).toBe(expectParent[r.region_type]);
      } else {
        expect(r.region_type).toBe("country");
      }
    }
  });

  it("is flagged synthetic with fictional codes, and carries Hindi/Odia names for the upper levels", () => {
    expect(geo.regions.every((r) => r.is_synthetic && r.administrative_code.startsWith("SYN-"))).toBe(true);
    const odisha = geo.regions.find((r) => r.name === "Odisha")!;
    expect(odisha.name_local).toEqual({ hi: "ओडिशा", or: "ଓଡ଼ିଶା" });
    expect(geo.regions.filter((r) => r.region_type === "district").every((r) => r.name_local.hi && r.name_local.or)).toBe(true);
  });
});

describe("dataset shape and privacy", () => {
  it("contains only allow-listed fields (no submitter, GPS, address, phone or e-mail)", () => {
    const allowed = [
      "age_band", "case_count", "client_submission_id", "free_text", "language", "observed_at", "region_id",
      "report_type", "severity", "source_type", "symptom_codes", "syndrome", "synthetic_batch",
    ];
    for (const r of ds.reports.slice(0, 500)) expect(Object.keys(r).sort()).toEqual(allowed);
  });

  it("uses only canned, digit-free free text and valid controlled vocabularies", () => {
    const pii = (t: string) => /(\d[\s.-]?){10,}/.test(t) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t);
    const texts = new Set(ds.reports.map((r) => r.free_text).filter((t): t is string => t !== null));
    expect(texts.size).toBeLessThanOrEqual(3);
    for (const t of texts) expect(pii(t)).toBe(false);
    for (const r of ds.reports) {
      for (const c of r.symptom_codes) expect(SYMPTOM_VOCAB.has(c)).toBe(true);
      expect(r.synthetic_batch).toBe(SYNTHETIC_BATCH);
      expect(r.report_type === "aggregate_count" ? r.source_type !== "citizen" : r.case_count === 1).toBe(true);
    }
  });

  it("references only block/locality regions, inside the generation window, with unique client ids", () => {
    const regionType = new Map(ds.geography.regions.map((r) => [r.id, r.region_type]));
    const first = `${START_DATE}T00:00:00.000Z`;
    const last = `${addDays(START_DATE, DAYS - 1)}T23:59:59.999Z`;
    for (const r of ds.reports) {
      expect(["block", "locality"]).toContain(regionType.get(r.region_id));
      expect(r.observed_at >= first && r.observed_at <= last).toBe(true);
    }
    expect(new Set(ds.reports.map((r) => r.client_submission_id)).size).toBe(ds.reports.length);
  });

  it("covers multiple districts, blocks, source types, syndromes, severities and languages", () => {
    const parent = new Map(ds.geography.regions.map((r) => [r.id, r.parent_region_id]));
    const block = (r: SyntheticReport) => (ds.geography.regions.find((x) => x.id === r.region_id)!.region_type === "block" ? r.region_id : parent.get(r.region_id)!);
    const blocks = new Set(ds.reports.map(block));
    const districts = new Set([...blocks].map((b) => parent.get(b)));
    expect(blocks.size).toBe(16);
    expect(districts.size).toBe(4);
    expect(new Set(ds.reports.map((r) => r.source_type)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(ds.reports.map((r) => r.syndrome)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(ds.reports.map((r) => r.severity)).size).toBe(4);
    expect(new Set(ds.reports.map((r) => r.language))).toEqual(new Set(["en", "hi", "or"]));
    expect(ds.reports.some((r) => r.language === "or" && r.free_text?.includes("ଝାଡ଼ା"))).toBe(true);
  });
});

describe("normal background variation", () => {
  // Reports per India-local date (observed_at is constructed so the UTC date equals the IST date).
  const date = (r: SyntheticReport) => r.observed_at.slice(0, 10);
  const geo = ds.geography;
  const blockOf = (regionId: string) => {
    const r = geo.regions.find((x) => x.id === regionId)!;
    return r.region_type === "block" ? r.id : r.parent_region_id!;
  };

  it("has a non-trivial baseline every week and day-to-day variation", () => {
    const perDay = new Map<string, number>();
    for (const r of ds.reports) perDay.set(date(r), (perDay.get(date(r)) ?? 0) + 1);
    expect(perDay.size).toBe(DAYS);
    const v = [...perDay.values()];
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
    expect(mean).toBeGreaterThan(30);
    expect(variance).toBeGreaterThan(1);
    for (let w = 0; w < 12; w++) {
      const week = Array.from({ length: 7 }, (_, i) => perDay.get(addDays(START_DATE, w * 7 + i)) ?? 0).reduce((a, b) => a + b, 0);
      expect(week).toBeGreaterThan(100);
    }
  });

  it("has a weekday pattern (Sundays are quieter than Mondays)", () => {
    const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    const tot = { sun: [0, 0], mon: [0, 0] };
    for (let i = 0; i < DAYS; i++) {
      const d = addDays(START_DATE, i);
      const n = ds.reports.filter((r) => date(r) === d).length;
      if (dow(d) === 0) { tot.sun[0] += n; tot.sun[1]++; }
      if (dow(d) === 1) { tot.mon[0] += n; tot.mon[1]++; }
    }
    expect(tot.sun[0] / tot.sun[1]).toBeLessThan(tot.mon[0] / tot.mon[1]);
  });

  describe("planted clusters (ground truth for M3; no detector exists in M2)", () => {
    const rate = (syndrome: string, blockIds: Set<string>, from: string, to: string) => {
      const days = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000 + 1;
      const n = ds.reports.filter((r) => r.syndrome === syndrome && blockIds.has(blockOf(r.region_id)) && date(r) >= from && date(r) <= to).length;
      return n / days;
    };

    it("lists clusters and one decoy with consistent metadata", () => {
      expect(ds.groundTruth.filter((e) => e.kind === "true_cluster")).toHaveLength(4);
      expect(ds.groundTruth.filter((e) => e.kind === "decoy_reporting_artifact")).toHaveLength(1);
      for (const e of ds.groundTruth) {
        expect(e.injected_report_count).toBeGreaterThan(0);
        expect(e.start_date <= e.end_date).toBe(true);
        for (const code of e.region_codes) expect(geo.byCode.get(code)?.region_type).toBe("block");
      }
    });

    for (const id of ["P1", "P2", "P3", "P4"]) {
      it(`${id}: reporting rate inside the planted window clearly exceeds the same blocks' rate outside every event window`, () => {
        const e = ds.groundTruth.find((x) => x.id === id)!;
        const blocks = new Set(e.region_codes.map((c) => geo.byCode.get(c)!.id));
        const inside = rate(e.syndrome, blocks, e.start_date, e.end_date);
        const eventWindows = ds.groundTruth.filter((x) => x.syndrome === e.syndrome && x.region_codes.some((c) => e.region_codes.includes(c)));
        // baseline = all other days of the same blocks/syndrome that are outside any event window
        let n = 0, days = 0;
        for (let i = 0; i < DAYS; i++) {
          const d = addDays(START_DATE, i);
          if (eventWindows.some((w) => d >= w.start_date && d <= w.end_date)) continue;
          days++;
          n += ds.reports.filter((r) => r.syndrome === e.syndrome && blocks.has(blockOf(r.region_id)) && date(r) === d).length;
        }
        const outside = n / days / 1; // reports per day across the event's blocks
        expect(inside).toBeGreaterThan(2.5 * outside);
      });
    }

    it("D1 decoy: a single-day bulk import from one source in one block, not a sustained rise", () => {
      const e = ds.groundTruth.find((x) => x.id === "D1")!;
      const dig = geo.byCode.get(e.region_codes[0])!.id;
      const burst = ds.reports.filter((r) => blockOf(r.region_id) === dig && date(r) === e.start_date && r.syndrome === "fever" && r.source_type === "imported_dataset");
      expect(burst.length).toBeGreaterThanOrEqual(40);
      const before = ds.reports.filter((r) => blockOf(r.region_id) === dig && r.syndrome === "fever" && date(r) === addDays(e.start_date, -1)).length;
      const after = ds.reports.filter((r) => blockOf(r.region_id) === dig && r.syndrome === "fever" && date(r) === addDays(e.start_date, 1)).length;
      expect(before).toBeLessThan(10);
      expect(after).toBeLessThan(10);
      expect(burst.every((r) => r.severity === "unknown")).toBe(true);
    });

    it("clusters shift severity upward relative to background", () => {
      const e = ds.groundTruth.find((x) => x.id === "P1")!;
      const bal = geo.byCode.get(e.region_codes[0])!.id;
      const inWin = ds.reports.filter((r) => r.syndrome === e.syndrome && blockOf(r.region_id) === bal && date(r) >= e.start_date && date(r) <= e.end_date);
      const bg = ds.reports.filter((r) => r.syndrome === e.syndrome && blockOf(r.region_id) !== bal);
      const sev = (xs: SyntheticReport[]) => xs.filter((r) => r.severity === "severe").length / xs.length;
      expect(sev(inWin)).toBeGreaterThan(sev(bg));
    });
  });
});
