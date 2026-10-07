// SSRF-safe fetcher for curator-run source retrieval. It is NEVER reachable from a browser or from user input:
// it runs only from admin scripts. Defences (each unit-tested with injected DNS/transport fakes):
//   * HTTPS only, standard port, no credentials, DNS names only, host must be on the curator's allow-list;
//   * DNS is resolved ONCE per hop and EVERY returned address must be public; the socket is then opened to that
//     exact validated address (SNI/Host carry the name), so DNS rebinding cannot swap in a private address;
//   * redirects are followed manually (max 3), re-validated each hop, and must stay inside the same allow-list
//     entry; a redirect to another domain, to http, or to an IP is refused;
//   * response limits: status 200 only, text content types only, no content-encoding, size cap, total deadline.
// There is no "allow private" switch: tests never open sockets, they inject a transport.
import { lookup } from "node:dns/promises";
import https from "node:https";
import { sha256Hex } from "../hash";
import { scanForInjection, type ScanResult } from "../ingest/inject";
import { sanitizeText, type SanitiseResult } from "../ingest/sanitize";
import type { Allowlist } from "../ingest/trust";
import { isBlockedIp } from "./ip";
import { checkUrl } from "./url";

export type FetchFailKind = "policy" | "network" | "http" | "content";

export class FetchError extends Error {
  constructor(readonly kind: FetchFailKind, readonly reason: string, readonly status?: number) {
    super(reason);
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

type Headers = Record<string, string | string[] | undefined>;

export interface TransportRequest {
  url: URL;
  /** The validated IP to connect to. */
  address: string;
  headers: Record<string, string>;
  /** Absolute deadline (epoch ms) for the whole fetch. */
  deadline: number;
  maxBytes: number;
  /** Called with status + headers before the body is read; throws FetchError to abort early. */
  precheck: (status: number, headers: Headers) => void;
}
export interface TransportResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (host: string) => Promise<string[]>;

export interface FetchDeps {
  resolve: Resolver;
  transport: Transport;
  now: () => number;
}

export type FetchResult =
  | {
      ok: true;
      finalUrl: string;
      status: 200;
      contentType: string;
      bytes: number;
      rawHash: string;
      /** Decoded body. UNTRUSTED: run it through the sanitiser before use. */
      text: string;
      lastModified: string | null;
      etag: string | null;
      redirects: string[];
    }
  | { ok: false; kind: FetchFailKind; reason: string; status?: number; redirects: string[] };

export const DEFAULT_FETCH_OPTIONS: Required<FetchOptions> = { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3 };
export const ACCEPTED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"] as const;
const CHARSETS: Record<string, string> = { "utf-8": "utf-8", utf8: "utf-8", "us-ascii": "utf-8", ascii: "utf-8", "iso-8859-1": "windows-1252", latin1: "windows-1252", "windows-1252": "windows-1252" };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Header-level response policy. Called by the real transport (early abort) and again by fetchSafe (so fakes obey it too). */
export function validateResponse(status: number, headers: Headers, maxBytes: number): void {
  if (REDIRECT_STATUSES.has(status)) return;
  if (status !== 200) throw new FetchError("http", `http_${status}`, status);
  const enc = one(headers["content-encoding"])?.trim().toLowerCase();
  if (enc && enc !== "identity") throw new FetchError("content", "unsupported_content_encoding");
  const ct = one(headers["content-type"]);
  const base = ct?.split(";")[0].trim().toLowerCase();
  if (!base || !(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(base)) throw new FetchError("content", `unsupported_content_type:${base ?? "missing"}`);
  const cs = /charset\s*=\s*"?([^";\s]+)/i.exec(ct ?? "")?.[1]?.toLowerCase();
  if (cs && !CHARSETS[cs]) throw new FetchError("content", `unsupported_charset:${cs}`);
  const len = Number(one(headers["content-length"]));
  if (Number.isFinite(len) && len > maxBytes) throw new FetchError("content", "too_large");
}

export const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export const httpsTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const remaining = req.deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError("network", "timeout"));
    const r = https.request(
      {
        host: req.address, port: 443, method: "GET", path: `${req.url.pathname}${req.url.search}`, agent: false,
        servername: req.url.hostname, headers: { ...req.headers, Host: req.url.hostname }, rejectUnauthorized: true, timeout: remaining,
      },
      (res) => {
        try {
          req.precheck(res.statusCode ?? 0, res.headers);
        } catch (e) {
          res.destroy();
          return reject(e);
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > req.maxBytes) {
            res.destroy();
            reject(new FetchError("content", "too_large"));
          } else parts.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
        res.on("error", (e) => reject(new FetchError("network", `response_error:${(e as NodeJS.ErrnoException).code ?? "unknown"}`)));
      },
    );
    const timer = setTimeout(() => r.destroy(new FetchError("network", "timeout")), remaining);
    r.on("timeout", () => r.destroy(new FetchError("network", "timeout")));
    r.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof FetchError ? e : new FetchError("network", `connection_error:${(e as NodeJS.ErrnoException).code ?? "unknown"}`));
    });
    r.on("close", () => clearTimeout(timer));
    r.end();
  });

export const REAL_DEPS: FetchDeps = { resolve: defaultResolver, transport: httpsTransport, now: () => Date.now() };

export async function fetchSafe(rawUrl: string, allowlist: Allowlist, options: FetchOptions = {}, deps: FetchDeps = REAL_DEPS): Promise<FetchResult> {
  const o = { ...DEFAULT_FETCH_OPTIONS, ...options };
  const redirects: string[] = [];
  const fail = (kind: FetchFailKind, reason: string, status?: number): FetchResult => ({ ok: false, kind, reason, status, redirects });
  const deadline = deps.now() + o.timeoutMs;
  let current = rawUrl;
  let entryDomain: string | null = null;

  for (let hop = 0; hop <= o.maxRedirects; hop += 1) {
    const chk = checkUrl(current, allowlist);
    if (chk.ok === false) return fail("policy", hop === 0 ? `url_rejected:${chk.reason}` : `redirect_rejected:${chk.reason}`);
    if (entryDomain && chk.entry.domain !== entryDomain) return fail("policy", "redirect_off_domain");
    entryDomain ??= chk.entry.domain;

    let addresses: string[];
    try {
      addresses = await deps.resolve(chk.host);
    } catch {
      return fail("network", "dns_failed");
    }
    if (!addresses.length) return fail("network", "dns_no_addresses");
    if (addresses.some(isBlockedIp)) return fail("policy", "blocked_address");

    let res: TransportResponse;
    try {
      res = await deps.transport({
        url: chk.url, address: addresses[0], deadline, maxBytes: o.maxBytes,
        headers: { "User-Agent": "JanSanket-EvidenceFetcher/1 (curator tool)", Accept: "text/html,text/plain;q=0.9", "Accept-Encoding": "identity" },
        precheck: (s, h) => validateResponse(s, h, o.maxBytes),
      });
    } catch (e) {
      return e instanceof FetchError ? fail(e.kind, e.reason, e.status) : fail("network", "transport_error");
    }
    if (deps.now() > deadline) return fail("network", "timeout");

    if (REDIRECT_STATUSES.has(res.status)) {
      const loc = one(res.headers.location);
      if (!loc) return fail("content", "redirect_without_location", res.status);
      if (hop === o.maxRedirects) return fail("policy", "too_many_redirects", res.status);
      try {
        current = new URL(loc, chk.url).toString();
      } catch {
        return fail("content", "redirect_invalid_location", res.status);
      }
      redirects.push(current);
      continue;
    }

    try {
      validateResponse(res.status, res.headers, o.maxBytes);
    } catch (e) {
      return e instanceof FetchError ? fail(e.kind, e.reason, res.status) : fail("content", "invalid_response", res.status);
    }
    if (res.body.length > o.maxBytes) return fail("content", "too_large", res.status);
    const ct = one(res.headers["content-type"]) ?? "";
    const cs = /charset\s*=\s*"?([^";\s]+)/i.exec(ct)?.[1]?.toLowerCase();
    return {
      ok: true, finalUrl: chk.url.toString(), status: 200, contentType: ct.split(";")[0].trim().toLowerCase(), bytes: res.body.length,
      rawHash: sha256Hex(res.body), text: new TextDecoder(cs ? CHARSETS[cs] : "utf-8").decode(res.body),
      lastModified: one(res.headers["last-modified"]) ?? null, etag: one(res.headers.etag) ?? null, redirects,
    };
  }
  return fail("policy", "too_many_redirects");
}

export interface FetchedSource {
  finalUrl: string;
  contentType: string;
  bytes: number;
  rawHash: string;
  lastModified: string | null;
  redirects: string[];
  sanitised: SanitiseResult;
  /** SHA-256 of the sanitised text: the value stored as evidence_versions.source_hash. */
  sourceHash: string;
  scan: ScanResult;
}

export type FetchSourceResult = ({ ok: true } & FetchedSource) | Extract<FetchResult, { ok: false }>;

/** Fetch, sanitise and scan one source. The returned text is inert plain text; the curator authors excerpts from it. */
export async function fetchSource(url: string, allowlist: Allowlist, language: "en" | "hi" | "or" = "en", options?: FetchOptions, deps?: FetchDeps): Promise<FetchSourceResult> {
  const r = await fetchSafe(url, allowlist, options, deps);
  if (r.ok === false) return r;
  const sanitised = sanitizeText(r.text);
  return {
    ok: true, finalUrl: r.finalUrl, contentType: r.contentType, bytes: r.bytes, rawHash: r.rawHash, lastModified: r.lastModified,
    redirects: r.redirects, sanitised, sourceHash: sha256Hex(sanitised.text),
    scan: scanForInjection(sanitised.text, { report: sanitised.report, removedFragments: sanitised.removedFragments, language }),
  };
}
