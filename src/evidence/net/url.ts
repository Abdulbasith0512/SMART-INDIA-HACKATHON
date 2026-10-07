// URL policy for the SSRF-safe fetcher: HTTPS only, no credentials, standard port, DNS name only (never an IP
// literal), and the host must be covered by the curator-maintained domain allow-list. Pure; no I/O.
import { isReservedHost } from "../ingest/document";
import { findAllowlistEntry, type Allowlist, type AllowlistEntry } from "../ingest/trust";

export type UrlRejection =
  | "too_long" | "invalid_url" | "not_https" | "credentials_in_url" | "port_not_allowed" | "ip_literal_host"
  | "single_label_host" | "non_ascii_host" | "reserved_host" | "domain_not_allowlisted";

export type UrlCheck = { ok: true; url: URL; host: string; entry: AllowlistEntry } | { ok: false; reason: UrlRejection };

const MAX_URL_LENGTH = 2000;

export function checkUrl(raw: string, allowlist: Allowlist): UrlCheck {
  const fail = (reason: UrlRejection): UrlCheck => ({ ok: false, reason });
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return fail("too_long");
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return fail("invalid_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("invalid_url");
  }
  if (url.protocol !== "https:") return fail("not_https");
  if (url.username || url.password) return fail("credentials_in_url");
  if (url.port && url.port !== "443") return fail("port_not_allowed");

  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") || host.includes(":")) return fail("ip_literal_host");
  if (host.endsWith(".")) {
    host = host.slice(0, -1); // fully-qualified form: normalise so SNI / Host / allow-list all see the same name
    url.hostname = host;
  }
  // WHATWG parsing already folds 0x7f.1 / 2130706433 / octal forms into dotted decimal; reject all numeric hosts.
  if (/^\d+(\.\d+)*$/.test(host) || /\.\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return fail("ip_literal_host");
  if (!/^[a-z0-9.-]+$/.test(host)) return fail("non_ascii_host");
  if (!host.includes(".") || host.includes("..")) return fail("single_label_host");
  if (isReservedHost(host)) return fail("reserved_host");

  const entry = findAllowlistEntry(host, allowlist);
  if (!entry) return fail("domain_not_allowlisted");
  url.hash = "";
  return { ok: true, url, host, entry };
}
