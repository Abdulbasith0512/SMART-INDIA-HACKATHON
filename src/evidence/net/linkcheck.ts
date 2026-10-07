// Link checker: re-fetches each REAL source (never synthetic ones) through the SSRF-safe fetcher and compares the
// sanitised-source hash with the one recorded when the version was ingested.
//   ok           same content            -> record fetch_status=ok
//   changed      content differs, or the new content trips the injection scanner -> quarantine until a curator reviews
//   unreachable  404/410 (definitive)    -> quarantine;  other failures are REPORTED only (could be transient)
//   blocked      policy refusal          -> quarantine if the domain left the allow-list or the source moved off-domain
// Nothing here deletes or edits content; it only records fetch bookkeeping and may quarantine.
import type { EvidenceDb, Row } from "../ingest/ingest";
import type { Allowlist } from "../ingest/trust";
import { fetchSource, type FetchDeps, type FetchOptions } from "./fetcher";

export type LinkResult = "ok" | "changed" | "unreachable" | "blocked" | "error" | "skipped";
export type LinkAction = "none" | "quarantine" | "report";

export interface LinkTarget {
  itemId: string;
  canonicalId: string;
  url: string | null;
  versionId: string | null;
  sourceHash: string | null;
  status: string;
  isSynthetic: boolean;
  language: "en" | "hi" | "or";
}

export interface LinkOutcome {
  canonicalId: string;
  itemId: string;
  versionId: string | null;
  url: string | null;
  result: LinkResult;
  action: LinkAction;
  detail: string;
  freshHash?: string;
}

export async function checkLink(t: LinkTarget, allowlist: Allowlist, options?: FetchOptions, deps?: FetchDeps): Promise<LinkOutcome> {
  const base = { canonicalId: t.canonicalId, itemId: t.itemId, versionId: t.versionId, url: t.url };
  if (t.isSynthetic || !t.url) return { ...base, result: "skipped", action: "none", detail: t.isSynthetic ? "synthetic document" : "no reference_url" };
  const r = await fetchSource(t.url, allowlist, t.language, options, deps);
  if (r.ok === false) {
    if (r.kind === "policy") {
      const moved = /domain_not_allowlisted|redirect_off_domain|redirect_rejected/.test(r.reason);
      return { ...base, result: "blocked", action: moved ? "quarantine" : "report", detail: r.reason };
    }
    if (r.kind === "http" && (r.status === 404 || r.status === 410)) return { ...base, result: "unreachable", action: "quarantine", detail: r.reason };
    return { ...base, result: "error", action: "report", detail: r.reason };
  }
  if (r.scan.verdict === "quarantine") return { ...base, result: "changed", action: "quarantine", detail: `scan_quarantine:${r.scan.rules.join("+")}`, freshHash: r.sourceHash };
  if (!t.sourceHash) return { ...base, result: "error", action: "report", detail: "no recorded source_hash to compare", freshHash: r.sourceHash };
  if (r.sourceHash !== t.sourceHash) return { ...base, result: "changed", action: "quarantine", detail: "source content differs from the ingested version", freshHash: r.sourceHash };
  return { ...base, result: "ok", action: "none", detail: "unchanged", freshHash: r.sourceHash };
}

export async function checkLinks(targets: LinkTarget[], allowlist: Allowlist, options?: FetchOptions, deps?: FetchDeps): Promise<LinkOutcome[]> {
  const out: LinkOutcome[] = [];
  for (const t of [...targets].sort((a, b) => (a.canonicalId < b.canonicalId ? -1 : 1))) out.push(await checkLink(t, allowlist, options, deps)); // sequential: polite to publishers
  return out;
}

export async function loadLinkTargets(db: EvidenceDb): Promise<LinkTarget[]> {
  const items = await db.select("evidence_items", { is_synthetic: false });
  const targets: LinkTarget[] = [];
  for (const it of items) {
    if (!it.reference_url || !it.canonical_id) continue;
    const v = (await db.select("evidence_versions", { evidence_item_id: it.id, is_current: true }))[0] as Row | undefined;
    targets.push({
      itemId: it.id as string, canonicalId: it.canonical_id as string, url: it.reference_url as string, versionId: (v?.id as string) ?? null,
      sourceHash: (v?.source_hash as string) ?? null, status: it.status as string, isSynthetic: false, language: ((it.language as string) ?? "en") as LinkTarget["language"],
    });
  }
  return targets;
}

/** Record the outcomes. Quarantine only where the status machine allows it; never raises or releases anything. */
export async function applyLinkOutcomes(db: EvidenceDb, outcomes: LinkOutcome[], now: string, statusOf: Map<string, string>): Promise<string[]> {
  const log: string[] = [];
  for (const o of outcomes) {
    if (o.result === "skipped" || !o.versionId) continue;
    const fetch_status = o.result === "ok" ? "ok" : o.result === "changed" ? "changed" : o.result === "unreachable" ? "unreachable" : null;
    if (fetch_status) await db.update("evidence_versions", { id: o.versionId }, { fetch_status, retrieved_at: now });
    const status = statusOf.get(o.itemId);
    if (o.action === "quarantine" && status && ["current", "draft"].includes(status)) {
      await db.update("evidence_items", { id: o.itemId }, { status: "quarantined" });
      log.push(`${o.canonicalId}: quarantined (${o.detail})`);
    }
  }
  return log;
}
