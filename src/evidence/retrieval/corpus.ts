// The retrieval engine's read-only view of the evidence corpus, and the loader that builds it from the database.
// The loader reads ONLY evidence tables (items, current versions, the chunks of CURRENT documents, and the
// active corpus snapshot). It never touches reports, observations, aggregates or signals. Row order from the
// database is never relied on: everything downstream sorts by stable identifiers.
import { hashJson } from "../hash";
import type { EvidenceDb, Row } from "../ingest/ingest";
import { compareCodePoints } from "./tokenize";

export interface CorpusChunk {
  id: string;
  ordinal: number;
  kind: string;
  text: string;
  chunkHash: string;
  language: string;
}

export interface CorpusItem {
  id: string;
  /** Stable semantic identity (unique per document edition by ingestion convention). Null only for pre-M4 rows. */
  canonicalId: string | null;
  title: string;
  publisher: string;
  sourceClass: string;
  evidenceKind: string | null;
  trustLevel: string;
  status: string;
  topics: string[];
  syndromes: string[];
  geoScope: string | null;
  geoRegionId: string | null;
  language: string | null;
  publicationDate: string | null;
  validFrom: string | null;
  validUntil: string | null;
  isSynthetic: boolean;
  supersedesId: string | null;
  /**
   * Curator-authored conflict tags (M4.3). Loaded for the ranking stage only: they are NOT part of retrieval
   * (M4.2 neither reads nor hashes them), so they never change a retrieval result or the corpus digest.
   */
  questionKey?: string | null;
  position?: string | null;
  version: { id: string; contentHash: string; fetchStatus: string } | null;
  /** Chunks of the CURRENT version only; empty for documents whose text was not loaded (not current). */
  chunks: CorpusChunk[];
}

export interface CorpusSnapshotRef {
  id: string;
  corpusHash: string;
  corpusVersion: string;
}

export interface CorpusView {
  items: CorpusItem[];
  activeSnapshot: CorpusSnapshotRef | null;
}

export const ITEM_COLUMNS = [
  "id", "canonical_id", "title", "publisher", "source_class", "evidence_kind", "trust_level", "status", "topics", "syndromes", "geo_scope",
  "geo_region_id", "language", "publication_date", "valid_from", "valid_until", "is_synthetic", "supersedes_id",
  "question_key", "position",
] as const;
export const VERSION_COLUMNS = ["id", "evidence_item_id", "content_hash", "fetch_status", "is_current"] as const;
export const CHUNK_COLUMNS = ["id", "version_id", "ordinal", "kind", "text", "chunk_hash", "language"] as const;
export const SNAPSHOT_COLUMNS = ["id", "corpus_hash", "corpus_version"] as const;

/** Dates arrive as strings from PostgREST and as Date objects from other drivers; normalise to YYYY-MM-DD. */
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const BATCH = 50;

async function inBatches(db: EvidenceDb, table: string, column: string, values: string[], columns: readonly string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < values.length; i += BATCH) out.push(...(await db.select(table, { [column]: values.slice(i, i + BATCH) }, columns)));
  return out;
}

export async function loadCorpusView(db: EvidenceDb, opts: { textStatuses?: readonly string[] } = {}): Promise<CorpusView> {
  const textStatuses = opts.textStatuses ?? ["current"];
  const items = await db.select("evidence_items", {}, ITEM_COLUMNS);
  const itemIds = items.map((i) => i.id as string);
  const versions = (await inBatches(db, "evidence_versions", "evidence_item_id", itemIds, VERSION_COLUMNS)).filter((v) => v.is_current === true);
  const versionByItem = new Map(versions.map((v) => [v.evidence_item_id as string, v]));

  // Text is loaded only for documents whose status could ever compete; others need metadata only.
  const textVersionIds = items.filter((i) => textStatuses.includes(i.status as string)).flatMap((i) => (versionByItem.has(i.id as string) ? [versionByItem.get(i.id as string)!.id as string] : []));
  const chunkRows = await inBatches(db, "evidence_chunks", "version_id", textVersionIds, CHUNK_COLUMNS);
  const chunksByVersion = new Map<string, CorpusChunk[]>();
  for (const c of chunkRows) {
    const list = chunksByVersion.get(c.version_id as string) ?? [];
    list.push({ id: c.id as string, ordinal: Number(c.ordinal), kind: String(c.kind), text: String(c.text), chunkHash: String(c.chunk_hash), language: String(c.language) });
    chunksByVersion.set(c.version_id as string, list);
  }

  const snap = (await db.select("corpus_snapshots", { is_active: true }, SNAPSHOT_COLUMNS))[0];
  return {
    items: items.map((r): CorpusItem => {
      const v = versionByItem.get(r.id as string);
      return {
        id: r.id as string,
        canonicalId: (r.canonical_id as string | null) ?? null,
        title: String(r.title),
        publisher: String(r.publisher),
        sourceClass: String(r.source_class),
        evidenceKind: (r.evidence_kind as string | null) ?? null,
        trustLevel: String(r.trust_level),
        status: String(r.status),
        topics: strArray(r.topics),
        syndromes: strArray(r.syndromes),
        geoScope: (r.geo_scope as string | null) ?? null,
        geoRegionId: (r.geo_region_id as string | null) ?? null,
        language: (r.language as string | null) ?? null,
        publicationDate: day(r.publication_date),
        validFrom: day(r.valid_from),
        validUntil: day(r.valid_until),
        isSynthetic: r.is_synthetic === true,
        supersedesId: (r.supersedes_id as string | null) ?? null,
        questionKey: (r.question_key as string | null) ?? null,
        position: (r.position as string | null) ?? null,
        version: v ? { id: v.id as string, contentHash: String(v.content_hash), fetchStatus: String(v.fetch_status) } : null,
        chunks: v ? [...(chunksByVersion.get(v.id as string) ?? [])].sort((a, b) => a.ordinal - b.ordinal) : [],
      };
    }),
    activeSnapshot: snap ? { id: snap.id as string, corpusHash: String(snap.corpus_hash), corpusVersion: String(snap.corpus_version) } : null,
  };
}

/** Stable key for an item: its semantic id when present, else its row id. */
export const itemKey = (i: Pick<CorpusItem, "canonicalId" | "id">): string => i.canonicalId ?? i.id;

/**
 * Content-addressed digest of exactly what retrieval could see: for every document, its identity, lifecycle,
 * trust, current-version content hash and chunk hashes (for documents whose text was loaded). Independent of row
 * order, of database-assigned UUIDs, and of timestamps - so two databases holding the same corpus agree.
 */
export function corpusDigest(view: CorpusView): string {
  const rows = view.items
    .map((i) => ({
      key: itemKey(i), status: i.status, trust: i.trustLevel, cls: i.sourceClass, scope: i.geoScope, topics: [...i.topics].sort(compareCodePoints),
      syndromes: [...i.syndromes].sort(compareCodePoints), lang: i.language, synthetic: i.isSynthetic,
      version: i.version ? { content: i.version.contentHash, fetch: i.version.fetchStatus } : null,
      chunks: [...i.chunks].sort((a, b) => a.ordinal - b.ordinal || compareCodePoints(a.chunkHash, b.chunkHash)).map((c) => [c.ordinal, c.chunkHash]),
    }))
    .sort((a, b) => compareCodePoints(a.key, b.key));
  return hashJson({ schema: "corpus-digest/1", rows });
}
