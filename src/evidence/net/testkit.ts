// Test doubles for the fetcher: an injectable resolver and transport. Tests never open a socket.
import type { FetchDeps, TransportRequest, TransportResponse } from "./fetcher";
import type { Allowlist } from "../ingest/trust";

export const ALLOW: Allowlist = {
  schema: "evidence-allowlist/1",
  entries: [
    { domain: "agency-one.org", classes: ["national_government_health_agency"] },
    { domain: "agency-two.org", classes: ["recognized_institution"] },
  ],
};

export const html = (body: string, extra: Record<string, string> = {}): TransportResponse => ({
  status: 200, headers: { "content-type": "text/html; charset=utf-8", ...extra }, body: new TextEncoder().encode(body),
});
export const redirect = (status: number, location: string): TransportResponse => ({ status, headers: { location }, body: new Uint8Array() });

export interface Recorded {
  requests: TransportRequest[];
  resolved: string[];
}

/** `responses` are served in order; the last one repeats. `dns` maps host -> addresses (default: one public address). */
export function fakeDeps(responses: Array<TransportResponse | Error>, dns: Record<string, string[] | Error> = {}, clock?: { now: () => number }): { deps: FetchDeps; rec: Recorded } {
  const rec: Recorded = { requests: [], resolved: [] };
  let i = 0;
  const deps: FetchDeps = {
    resolve: async (host) => {
      rec.resolved.push(host);
      const r = dns[host] ?? ["93.184.216.34"];
      if (r instanceof Error) throw r;
      return r;
    },
    transport: async (req) => {
      rec.requests.push(req);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      req.precheck(r.status, r.headers);
      return r;
    },
    now: clock?.now ?? (() => Date.now()),
  };
  return { deps, rec };
}
