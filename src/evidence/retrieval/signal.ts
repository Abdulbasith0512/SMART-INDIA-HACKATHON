// SignalFacts: the ONLY thing about a signal that the retrieval pipeline ever sees.
//
// It is a deliberately small, strict projection of an M3 candidate: the syndrome, the officer-visible region
// (plus its ancestors, for geography matching), the signal window as dates, the names of the involved blocks
// (already shown to officers), and two coarse characteristics derived from M3 score components. It contains NO
// counts, NO explanation text, NO raw or de-identified rows, NO names of people, NO contact details and NO
// coordinates. The schema is strict, so an extra field is rejected rather than silently carried along, and the
// loader names the exact columns it reads (data minimisation).
//
// This module does not import the detector (isolation rule). It reads the stored candidate row only.
import { z } from "zod";
import type { EvidenceDb, Row } from "../ingest/ingest";
import { CHARACTERISTIC_THRESHOLDS, type Persistence, type Spread } from "./queryConfig";

export const SIGNAL_FACTS_SCHEMA = "signal-facts/1";
export const SIGNAL_SYNDROMES = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idStr = z.string().regex(/^[0-9a-fA-F-]{36}$/, "expected a UUID");
const nameStr = z.string().min(1).max(120);

export const signalFactsSchema = z
  .object({
    schema: z.literal(SIGNAL_FACTS_SCHEMA),
    signal_id: idStr,
    syndrome: z.enum(SIGNAL_SYNDROMES),
    region: z.object({ id: idStr, name: nameStr, level: z.enum(["state", "district", "block", "locality"]) }).strict(),
    /** Nearest first (e.g. district, state, country). */
    ancestors: z.array(z.object({ id: idStr, name: nameStr, level: z.enum(["country", "state", "district", "block"]) }).strict()).max(5),
    /** Inclusive calendar dates in India Standard Time. */
    window: z.object({ start: isoDate, end: isoDate }).strict(),
    involved_blocks: z.array(z.object({ id: idStr, name: nameStr }).strict()).max(60),
    spread: z.enum(["single_block", "multi_block", "district_wide", "unknown"]),
    persistence: z.enum(["emerging", "sustained", "unknown"]),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.window.end < f.window.start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window"], message: "window ends before it starts" });
  });

export type SignalFacts = z.infer<typeof signalFactsSchema>;

/** The exact candidate columns retrieval reads. Nothing else about a candidate is ever requested. */
export const SIGNAL_COLUMNS = ["id", "syndrome", "region_id", "time_window_start", "time_window_end", "score_components", "evidence"] as const;
export const REGION_COLUMNS = ["id", "name", "region_type", "parent_region_id"] as const;

export interface RegionRow {
  id: string;
  name: string;
  region_type: string;
  parent_region_id: string | null;
}

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in India Standard Time. */
export function istDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RangeError(`not a timestamp: ${iso}`);
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The stored window end is exclusive (midnight of the next day); the inclusive last day is one millisecond earlier. */
export const istInclusiveEndDate = (iso: string): string => istDate(new Date(Date.parse(iso) - 1).toISOString());

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function classifySpread(regionLevel: string, involved: number, blocksInDistrict: number | null): Spread {
  if (regionLevel === "block" || involved === 1) return "single_block";
  if (involved > 1 && blocksInDistrict && blocksInDistrict > 0) return involved / blocksInDistrict >= CHARACTERISTIC_THRESHOLDS.districtWideShare ? "district_wide" : "multi_block";
  return "unknown";
}

export function classifyPersistence(p: number | null): Persistence {
  if (p === null) return "unknown";
  return p >= CHARACTERISTIC_THRESHOLDS.sustainedPersistence ? "sustained" : "emerging";
}

/**
 * Project a stored M3 candidate row onto SignalFacts. `regions` must contain the candidate's region and its
 * ancestors. Everything not named here is dropped; the result is validated against the strict schema.
 */
export function signalFactsFromCandidate(row: Row, regions: ReadonlyMap<string, RegionRow>): SignalFacts {
  const chain: RegionRow[] = [];
  for (let id = row.region_id as string | null, hops = 0; id && hops < 8; hops += 1) {
    const r = regions.get(id);
    if (!r) throw new Error(`region ${id} missing from the region lookup`);
    chain.push(r);
    id = r.parent_region_id;
  }
  if (!chain.length) throw new Error("candidate has no region");
  const [self, ...up] = chain;

  const comp = obj(row.score_components);
  const ev = obj(row.evidence);
  const blocks = (Array.isArray(ev.involved_blocks) ? ev.involved_blocks : [])
    .map((b) => obj(b))
    .filter((b) => typeof b.id === "string" && typeof b.name === "string")
    .map((b) => ({ id: b.id as string, name: b.name as string }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  const involved = blocks.length || finite(comp.involvedBlocks) || 0;

  return signalFactsSchema.parse({
    schema: SIGNAL_FACTS_SCHEMA,
    signal_id: row.id,
    syndrome: row.syndrome,
    region: { id: self.id, name: self.name, level: self.region_type },
    ancestors: up.map((r) => ({ id: r.id, name: r.name, level: r.region_type })),
    window: { start: istDate(String(row.time_window_start)), end: istInclusiveEndDate(String(row.time_window_end)) },
    involved_blocks: blocks,
    spread: classifySpread(self.region_type, involved, finite(comp.blocksInDistrict)),
    persistence: classifyPersistence(finite(comp.persistence)),
  });
}

/** Read one candidate (named columns only) and its region chain, and project it. Null when the id is unknown. */
export async function loadSignalFacts(db: EvidenceDb, signalId: string): Promise<SignalFacts | null> {
  const row = (await db.select("signal_candidates", { id: signalId }, SIGNAL_COLUMNS))[0];
  if (!row) return null;
  const regions = new Map<string, RegionRow>();
  let frontier: string[] = [row.region_id as string];
  for (let hop = 0; frontier.length && hop < 8; hop += 1) {
    const rows = (await db.select("regions", { id: frontier }, REGION_COLUMNS)) as unknown as RegionRow[];
    frontier = [];
    for (const r of rows) {
      regions.set(r.id, r);
      if (r.parent_region_id && !regions.has(r.parent_region_id)) frontier.push(r.parent_region_id);
    }
  }
  return signalFactsFromCandidate(row, regions);
}
