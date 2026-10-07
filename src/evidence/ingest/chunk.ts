// Chunking: the chunk is the unit of retrieval AND of citation. Abstract text is packed into bounded chunks on
// sentence boundaries; curator excerpts are each kept whole (a deliberate, verbatim unit) and must fit the limit.
import { sha256Hex } from "../hash";

export const MAX_CHUNK_CHARS = 1200; // packing target for abstracts
export const DB_MAX_CHUNK_CHARS = 1500; // hard limit (evidence_chunks_len_chk)

export interface ChunkSpec {
  ordinal: number;
  kind: "abstract" | "excerpt";
  text: string;
  chunk_hash: string;
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Pack sanitised text into chunks of at most `max` characters, never crossing a paragraph break. Deterministic. */
export function packText(text: string, max = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const sentences = paragraph.split(/(?<=[.!?।॥])\s+/).map((s) => s.trim()).filter(Boolean);
    let current = "";
    const flush = () => {
      if (current) chunks.push(current);
      current = "";
    };
    for (const sentence of sentences) {
      for (const piece of sentence.length > max ? hardSplit(sentence, max) : [sentence]) {
        if (current && current.length + 1 + piece.length > max) flush();
        current = current ? `${current} ${piece}` : piece;
      }
    }
    flush();
  }
  return chunks;
}

export class ChunkError extends Error {}

/** Abstract chunks first (ordinal 0..), then one chunk per excerpt. Throws on empty, oversize or duplicate chunks. */
export function buildChunks(abstract: string, excerpts: string[]): ChunkSpec[] {
  const specs: Array<Pick<ChunkSpec, "kind" | "text">> = [];
  for (const text of abstract ? packText(abstract) : []) specs.push({ kind: "abstract", text });
  excerpts.forEach((text, i) => {
    if (!text) throw new ChunkError(`excerpt ${i} is empty after sanitising`);
    if (text.length > DB_MAX_CHUNK_CHARS) throw new ChunkError(`excerpt ${i} is ${text.length} characters (limit ${DB_MAX_CHUNK_CHARS}); shorten it`);
    specs.push({ kind: "excerpt", text });
  });
  if (!specs.length) throw new ChunkError("document has no abstract and no excerpts");
  const seen = new Set<string>();
  return specs.map((s, ordinal) => {
    if (seen.has(s.text)) throw new ChunkError(`duplicate chunk text at ordinal ${ordinal}`);
    seen.add(s.text);
    return { ordinal, kind: s.kind, text: s.text, chunk_hash: sha256Hex(s.text) };
  });
}
