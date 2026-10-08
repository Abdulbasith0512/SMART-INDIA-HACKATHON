// Test helpers for the retrieval engine (not a test file itself): an in-memory CorpusView built from the committed
// development corpus (exactly what ingestion would store, with deterministic ids), and SignalFacts builders.
import { join } from "node:path";
import { hashJson } from "../hash";
import { buildCorpus } from "../ingest/loader";
import type { PreparedDocument } from "../ingest/prepare";
import type { CorpusChunk, CorpusItem, CorpusView } from "./corpus";
import { SIGNAL_FACTS_SCHEMA, signalFactsSchema, type SignalFacts } from "./signal";

/** Deterministic UUID-shaped id from a label. */
export const uid = (label: string): string => {
  const h = hashJson(label);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export const REGION = {
  country: uid("region:SYN-IN"),
  state: uid("region:SYN-OD"),
  khordha: uid("region:SYN-OD-KHO"),
  ganjam: uid("region:SYN-OD-GAN"),
  balianta: uid("region:SYN-OD-KHO-BAL"),
  jatni: uid("region:SYN-OD-KHO-JAT"),
  aska: uid("region:SYN-OD-GAN-ASK"),
  /** A state other than Odisha, for wrong-state tests. */
  otherState: uid("region:OTHER-STATE"),
  otherDistrict: uid("region:OTHER-DISTRICT"),
};
const REGION_BY_CODE: Record<string, string> = { "SYN-OD": REGION.state, "SYN-OD-KHO": REGION.khordha, "SYN-OD-GAN": REGION.ganjam };

const ROOT = process.cwd();
let cached: PreparedDocument[] | null = null;
export function devPrepared(): PreparedDocument[] {
  cached ??= buildCorpus(join(ROOT, "data", "evidence", "corpus"), join(ROOT, "data", "evidence", "allowlist.json"), "jansanket-dev-corpus").prepared;
  return cached;
}

/** What loadCorpusView would return after ingestion: text only for status `current`, current version only. */
export function viewFromPrepared(prepared: readonly PreparedDocument[] = devPrepared(), snapshot: CorpusView["activeSnapshot"] = null): CorpusView {
  const idOf = new Map(prepared.map((p) => [p.doc.canonical_id, uid(`item:${p.doc.canonical_id}`)]));
  const items = prepared.map((p): CorpusItem => {
    const d = p.doc;
    const status = p.decision.status;
    const chunks: CorpusChunk[] =
      status === "current"
        ? p.chunks.map((c) => ({ id: uid(`chunk:${d.canonical_id}:${c.ordinal}`), ordinal: c.ordinal, kind: c.kind, text: c.text, chunkHash: c.chunk_hash, language: d.language }))
        : [];
    return {
      id: idOf.get(d.canonical_id)!, canonicalId: d.canonical_id, title: p.fields.title, publisher: p.fields.publisher, sourceClass: d.source_class,
      evidenceKind: d.evidence_kind, trustLevel: p.decision.trustLevel, status, topics: [...d.topics], syndromes: [...d.syndromes], geoScope: d.geo_scope,
      geoRegionId: d.geo_region_code ? REGION_BY_CODE[d.geo_region_code] : null, language: d.language, publicationDate: d.publication_date,
      validFrom: d.valid_from, validUntil: d.valid_until, isSynthetic: d.is_synthetic, supersedesId: d.supersedes ? idOf.get(d.supersedes) ?? null : null,
      version: { id: uid(`version:${d.canonical_id}`), contentHash: p.contentHash, fetchStatus: "not_fetched" }, chunks,
    };
  });
  return { items, activeSnapshot: snapshot };
}

export interface FactsOverrides {
  syndrome?: SignalFacts["syndrome"];
  region?: SignalFacts["region"];
  ancestors?: SignalFacts["ancestors"];
  window?: SignalFacts["window"];
  involved_blocks?: SignalFacts["involved_blocks"];
  spread?: SignalFacts["spread"];
  persistence?: SignalFacts["persistence"];
  signal_id?: string;
}

/** A single-block signal in Balianta (Khordha district, Odisha), acute diarrhoeal illness, early September. */
export function makeFacts(o: FactsOverrides = {}): SignalFacts {
  return signalFactsSchema.parse({
    schema: SIGNAL_FACTS_SCHEMA,
    signal_id: o.signal_id ?? uid("signal:default"),
    syndrome: o.syndrome ?? "acute_diarrhoeal_illness",
    region: o.region ?? { id: REGION.balianta, name: "Balianta", level: "block" },
    ancestors: o.ancestors ?? [
      { id: REGION.khordha, name: "Khordha", level: "district" },
      { id: REGION.state, name: "Odisha", level: "state" },
      { id: REGION.country, name: "India", level: "country" },
    ],
    window: o.window ?? { start: "2025-09-01", end: "2025-09-07" },
    involved_blocks: o.involved_blocks ?? [{ id: REGION.balianta, name: "Balianta" }],
    spread: o.spread ?? "single_block",
    persistence: o.persistence ?? "sustained",
  });
}

/** The same signal but located in Ganjam district (a different district of the same state). */
export const ganjamFacts = (o: FactsOverrides = {}): SignalFacts =>
  makeFacts({
    region: { id: REGION.aska, name: "Aska", level: "block" },
    ancestors: [{ id: REGION.ganjam, name: "Ganjam", level: "district" }, { id: REGION.state, name: "Odisha", level: "state" }, { id: REGION.country, name: "India", level: "country" }],
    involved_blocks: [{ id: REGION.aska, name: "Aska" }],
    ...o,
  });

/** The same signal located in a different state altogether. */
export const otherStateFacts = (o: FactsOverrides = {}): SignalFacts =>
  makeFacts({
    region: { id: REGION.otherDistrict, name: "Elsewhere District", level: "district" },
    ancestors: [{ id: REGION.otherState, name: "Elsewhere State", level: "state" }, { id: REGION.country, name: "India", level: "country" }],
    involved_blocks: [],
    spread: "unknown",
    ...o,
  });

export const SYNDROMES = ["acute_diarrhoeal_illness", "fever", "fever_with_rash", "jaundice", "respiratory_illness"] as const;
