// Trust / source-class rules. Trust is CATEGORICAL and auditable (issuer class + verification basis + status),
// never a numeric truth score. A document's effective status is its curator-declared status, capped by what the
// rules below allow: the scanner can quarantine, and anything not fully described, allow-listed and
// curator-reviewed (real documents) fails closed to `draft`. Declarations can lower safety checks never raise them.
import type { CorpusDocument } from "./document";
import { isReservedHost } from "./document";
import type { ScanResult } from "./inject";
import { SOURCE_CLASS_TIERS, type SourceClass } from "../vocab";
import { z } from "zod";

export const TRUST_RULES_VERSION = "trust-rules/1.0.0";

export type EffectiveStatus = CorpusDocument["declared_status"];

export const allowlistSchema = z
  .object({
    schema: z.literal("evidence-allowlist/1"),
    entries: z
      .array(
        z.object({
          domain: z.string().regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "lowercase DNS domain, no wildcard, no IP"),
          classes: z.array(z.enum(SOURCE_CLASS_TIERS as unknown as [string, ...string[]])).min(1),
          note: z.string().max(300).optional(),
        }).strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    a.entries.forEach((e, i) => {
      if (seen.has(e.domain)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "domain"], message: "duplicate domain" });
      seen.add(e.domain);
      if (isReservedHost(e.domain)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "domain"], message: "reserved names cannot be allow-listed" });
      if (e.classes.includes("unverified")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "classes"], message: "'unverified' cannot be allow-listed" });
    });
  });

export type Allowlist = z.infer<typeof allowlistSchema>;
export type AllowlistEntry = Allowlist["entries"][number];

export const EMPTY_ALLOWLIST: Allowlist = { schema: "evidence-allowlist/1", entries: [] };

export function parseAllowlist(raw: unknown): { allowlist: Allowlist | null; errors: string[] } {
  const r = allowlistSchema.safeParse(raw);
  return r.success
    ? { allowlist: r.data, errors: [] }
    : { allowlist: null, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** True when `host` is the allow-listed domain or one of its subdomains (never a mere suffix match). */
export const hostMatchesDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export function findAllowlistEntry(host: string, allowlist: Allowlist): AllowlistEntry | null {
  const h = host.toLowerCase();
  // The most specific (longest) matching entry wins.
  return allowlist.entries.filter((e) => hostMatchesDomain(h, e.domain)).sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

export interface TrustDecision {
  status: EffectiveStatus;
  trustLevel: CorpusDocument["trust_level"];
  /** Machine-readable reasons the effective state differs from the declaration (empty when it does not). */
  reasons: string[];
}

const NEEDS_READINESS: ReadonlySet<EffectiveStatus> = new Set(["current", "superseded", "historical"]);

export function decideEffectiveState(doc: CorpusDocument, scan: ScanResult, allowlist: Allowlist = EMPTY_ALLOWLIST): TrustDecision {
  const reasons: string[] = [];
  let status: EffectiveStatus = doc.declared_status;
  let trustLevel = doc.trust_level;

  if (scan.verdict === "quarantine" && status !== "withdrawn") {
    return { status: "quarantined", trustLevel, reasons: [`scan_quarantine:${scan.rules.join("+")}`] };
  }

  if (!doc.is_synthetic) {
    // Real documents: allow-list + curator review are mandatory before they may be trusted at all.
    const host = doc.reference_url ? new URL(doc.reference_url).hostname.toLowerCase() : null;
    const entry = host ? findAllowlistEntry(host, allowlist) : null;
    if (!entry) reasons.push("domain_not_allowlisted");
    else if (!(entry.classes as string[]).includes(doc.source_class)) reasons.push("source_class_not_permitted_for_domain");
    if (doc.source_domain && host && !hostMatchesDomain(host, doc.source_domain)) reasons.push("source_domain_mismatch");
    if (!doc.verification_basis.includes("domain_allowlist")) reasons.push("missing_basis_domain_allowlist");
    if (!doc.curator_reviewed || !doc.verification_basis.includes("curator_reviewed")) reasons.push("curator_review_missing");
    if (reasons.length && trustLevel !== "unreviewed") trustLevel = "unreviewed";
  }

  if (NEEDS_READINESS.has(status)) {
    if (doc.source_class === "unverified") reasons.push("unverified_source_class");
    if (trustLevel === "unreviewed") reasons.push("trust_level_unreviewed");
    if (reasons.length) status = "draft";
  }
  return { status, trustLevel, reasons };
}

export const isRetrievableClass = (c: SourceClass): boolean => c !== "unverified";
