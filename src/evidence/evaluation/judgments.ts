// Reference relevance judgments (graded 0/1/2) at the evidence-chunk level.
//
// LABEL: synthetic_reference_judgment. These are NOT expert judgments. The project authored, by reading each synthetic
// document, a table of which facet(s) of a verification each document speaks to (data/evidence/eval/doc-roles.json). The
// functions here apply that table and a few explicit rules - they do not import or call the retrieval or ranking code - to
// produce a grade for every chunk a scenario's corpus contains:
//
//   grade 2  highly relevant: the document's hand-authored role for the facet is 2 and the chunk is substantive text
//   grade 1  partially relevant: role 1, or an abstract chunk of a role-2 document (abstracts describe, excerpts state),
//            or an aged situation report / surveillance summary (older than one year at the as-of date)
//   grade 0  everything not listed; listed explicitly only where the DOCUMENT is relevant in content but must not be
//            presented (stale, wrong place, other language, not eligible under the profile) or is an annotated distractor
//
// Because the roles are written against the same synthetic documents and the same controlled vocabulary as the
// pipeline, agreement between these judgments and retrieval is expected to be high. That is a property of the benchmark, not evidence about real evidence.
import type { QueryFacet } from "../vocab";
import { QUERY_FACETS } from "../vocab";
import type { CorpusItem } from "../retrieval/corpus";
import { compareCodePoints } from "../retrieval/tokenize";
import { hashJson } from "../hash";
import { ineligibleReasons } from "./oracle";
import { daysBetween, type CorpusBase, type ScenarioInputs } from "./scenarioCorpus";
import { chunkKey, JUDGMENT_LABEL, type DocRoles, type Grade, type JudgmentRow, type Scenario } from "./types";

export const AGED_DAYS = 365;
export const JUDGMENT_CONVENTION =
  "Unlisted (scenario, facet, chunk) = grade 0. Excerpt chunks take the document's hand-authored facet role; abstract chunks are capped at 1; situation reports and " +
  "surveillance summaries older than 365 days at the as-of date are capped at 1; a document that names a syndrome applies only to that syndrome. A grade-0 row with an " +
  "ineligible_reason marks a document whose content is relevant but which must not be presented in this scenario.";

export const docRolesHash = (roles: DocRoles): string => hashJson(roles);

interface DocChunks {
  item: CorpusItem;
  chunks: Array<{ ordinal: number; kind: string }>;
}

/** All documents of the scenario's corpus (current text and the historical text of superseded documents), by canonical id. */
function docsOf(inputs: ScenarioInputs): Map<string, DocChunks> {
  const out = new Map<string, DocChunks>();
  for (const view of [inputs.view, inputs.historicalView]) {
    for (const item of view.items) {
      if (!item.canonicalId) continue;
      const entry = out.get(item.canonicalId) ?? { item, chunks: [] };
      if (item.chunks.length) entry.chunks = item.chunks.map((c) => ({ ordinal: c.ordinal, kind: c.kind }));
      if (view === inputs.view) entry.item = item;
      out.set(item.canonicalId, entry);
    }
  }
  return out;
}

export function judgeScenario(scenario: Scenario, inputs: ScenarioInputs, roles: DocRoles): JudgmentRow[] {
  const ctx = {
    asOf: inputs.asOfDate,
    chain: [{ id: inputs.facts.region.id, level: inputs.facts.region.level as string }, ...inputs.facts.ancestors.map((a) => ({ id: a.id, level: a.level as string }))],
    profile: inputs.retrievalProfile,
  };
  const rows: JudgmentRow[] = [];
  const docs = [...docsOf(inputs).entries()].sort((a, b) => compareCodePoints(a[0], b[0]));
  for (const [id, { item, chunks }] of docs) {
    const role = roles.roles[id];
    if (!role || chunks.length === 0) continue;
    const facetsOfRole = QUERY_FACETS.filter((f) => (role.facets as Record<string, number>)[f] > 0);
    const applies = item.syndromes.length === 0 || item.syndromes.includes(inputs.facts.syndrome);

    if (role.role === "irrelevant_distractor") {
      for (const f of QUERY_FACETS) for (const c of chunks) rows.push(row(scenario.id, f, id, c.ordinal, 0, "distractor", `annotated irrelevant distractor: ${short(role.justification)}`, "irrelevant_distractor"));
      continue;
    }
    if (!applies) continue; // a document about another syndrome is simply irrelevant: not listed
    const reasons = ineligibleReasons(item, ctx);
    const aged = (item.evidenceKind === "situation_report" || item.evidenceKind === "surveillance_data") && item.publicationDate !== null && daysBetween(item.publicationDate, ctx.asOf) > AGED_DAYS;
    for (const f of facetsOfRole) {
      const base = (role.facets as Record<string, 1 | 2>)[f];
      for (const c of chunks) {
        if (reasons.length) {
          rows.push(row(scenario.id, f, id, c.ordinal, 0, `ineligible:${reasons[0]}`, `content relevant (role ${base}) but not presentable: ${reasons.join(", ")}`, reasons.join("+")));
          continue;
        }
        let grade: Grade = base;
        const why: string[] = [`document role ${f}=${base}`];
        if (c.kind === "abstract" && grade > 1) {
          grade = 1;
          why.push("abstract chunk capped at 1");
        }
        if (aged && grade > 1) {
          grade = 1;
          why.push(`older than ${AGED_DAYS} days at the as-of date, capped at 1`);
        }
        if (role.role === "redundant_copy") why.push(`redundant copy of ${role.redundant_copy_of}`);
        rows.push(row(scenario.id, f, id, c.ordinal, grade, `role:${f}:${base}${grade < base ? ":capped" : ""}`, why.join("; ")));
      }
    }
  }
  return rows.sort((a, b) => compareCodePoints(a.facet, b.facet) || compareCodePoints(a.canonical_id, b.canonical_id) || a.chunk_ordinal - b.chunk_ordinal);
}

const short = (s: string): string => (s.length > 70 ? `${s.slice(0, 67)}...` : s);
function row(scenario: string, facet: QueryFacet, canonical: string, ordinal: number, grade: Grade, rule: string, justification: string, ineligible?: string): JudgmentRow {
  return { scenario, facet, canonical_id: canonical, chunk_ordinal: ordinal, grade, ...(ineligible ? { ineligible_reason: ineligible } : {}), rule, justification };
}

/** Lookup: scenario -> facet -> chunkKey -> grade (rows with grade 0 included, so "judged irrelevant" differs from "never listed"). */
export function indexJudgments(rows: readonly JudgmentRow[]): Map<string, Map<QueryFacet, Map<string, JudgmentRow>>> {
  const out = new Map<string, Map<QueryFacet, Map<string, JudgmentRow>>>();
  for (const r of rows) {
    const byFacet = out.get(r.scenario) ?? new Map();
    const byChunk = byFacet.get(r.facet) ?? new Map();
    byChunk.set(chunkKey(r.canonical_id, r.chunk_ordinal), r);
    byFacet.set(r.facet, byChunk);
    out.set(r.scenario, byFacet);
  }
  return out;
}

export const gradeOf = (index: ReturnType<typeof indexJudgments>, scenario: string, facet: QueryFacet, canonicalId: string, ordinal: number): Grade =>
  (index.get(scenario)?.get(facet)?.get(chunkKey(canonicalId, ordinal))?.grade ?? 0) as Grade;

export const judgeAll = (scenarios: readonly Scenario[], inputsOf: (s: Scenario) => ScenarioInputs, roles: DocRoles): JudgmentRow[] => scenarios.flatMap((s) => judgeScenario(s, inputsOf(s), roles));

export type { CorpusBase };
export { JUDGMENT_LABEL };
