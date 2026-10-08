// Conflict detection from CURATOR-AUTHORED tags only.
//
// A conflict exists when two or more selected DOCUMENTS carry the same `question_key` and at least two different
// `position` codes. Nothing is inferred: no model, no text similarity, no BM25. A document without tags can never
// be part of a conflict, and with no tags at all the answer is simply "no conflicts" - never a guess.
import type { QueryFacet } from "../vocab";
import { compareCodePoints } from "../retrieval/tokenize";
import type { ConflictDocument, ConflictEntry, RankedCandidate } from "./types";

/** Reserved position code: the curator judges this evidence to contradict the apparent interpretation of a signal. */
export const CONTRADICTS_SIGNAL = "contradicts_signal_interpretation";

export interface ConflictTag {
  questionKey: string | null;
  position: string | null;
}

export function detectConflicts(selected: readonly RankedCandidate[], tags: ReadonlyMap<string, ConflictTag>): ConflictEntry[] {
  // One entry per tagged DOCUMENT among the selected chunks.
  const docs = new Map<string, ConflictDocument & { questionKey: string; position: string }>();
  for (const c of selected) {
    const t = tags.get(c.evidenceItemId);
    if (!t || t.questionKey === null || t.position === null) continue;
    const d = docs.get(c.evidenceItemId) ?? {
      canonicalId: c.canonicalId, evidenceItemId: c.evidenceItemId, publisher: c.metadata.publisher, sourceClass: c.metadata.sourceClass,
      facets: [] as QueryFacet[], chunkIds: [] as string[], questionKey: t.questionKey, position: t.position,
    };
    if (!d.facets.includes(c.facet)) d.facets.push(c.facet);
    if (!d.chunkIds.includes(c.chunkId)) d.chunkIds.push(c.chunkId);
    docs.set(c.evidenceItemId, d);
  }

  const byQuestion = new Map<string, Array<ConflictDocument & { position: string }>>();
  for (const d of docs.values()) {
    const list = byQuestion.get(d.questionKey) ?? [];
    list.push(d);
    byQuestion.set(d.questionKey, list);
  }

  const out: ConflictEntry[] = [];
  for (const [questionKey, list] of [...byQuestion.entries()].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    const positions = [...new Set(list.map((d) => d.position))].sort(compareCodePoints);
    if (positions.length < 2) continue;
    out.push({
      questionKey,
      positions: positions.map((position) => ({
        position,
        documents: list
          .filter((d) => d.position === position)
          .map(({ position: _p, ...d }) => ({ ...d, facets: [...d.facets].sort(compareCodePoints) as QueryFacet[], chunkIds: [...d.chunkIds].sort(compareCodePoints) }))
          .sort((a, b) => compareCodePoints(a.canonicalId ?? a.evidenceItemId, b.canonicalId ?? b.evidenceItemId)),
      })),
      basis: "curator_tags",
      note: "Reported from curator-authored question_key / position tags. No disagreement was inferred.",
    });
  }
  return out;
}

/** Selected documents a curator tagged as contradicting the apparent interpretation of the signal. */
export function contradictingDocuments(selected: readonly RankedCandidate[], tags: ReadonlyMap<string, ConflictTag>): Array<{ canonicalId: string | null; evidenceItemId: string; questionKey: string | null }> {
  const seen = new Map<string, { canonicalId: string | null; evidenceItemId: string; questionKey: string | null }>();
  for (const c of selected) {
    const t = tags.get(c.evidenceItemId);
    if (t?.position === CONTRADICTS_SIGNAL && !seen.has(c.evidenceItemId)) seen.set(c.evidenceItemId, { canonicalId: c.canonicalId, evidenceItemId: c.evidenceItemId, questionKey: t.questionKey });
  }
  return [...seen.values()].sort((a, b) => compareCodePoints(a.canonicalId ?? a.evidenceItemId, b.canonicalId ?? b.evidenceItemId));
}
