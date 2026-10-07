// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EMPTY_ALLOWLIST } from "../ingest/trust";
import { ALLOW } from "./testkit";
import { checkUrl } from "./url";

const reason = (u: string, al = ALLOW) => {
  const r = checkUrl(u, al);
  return r.ok === false ? r.reason : "ok";
};

describe("URL policy", () => {
  it("accepts https URLs on allow-listed domains and subdomains, dropping the fragment", () => {
    const r = checkUrl("https://agency-one.org/path?q=1#frag", ALLOW);
    expect(r.ok && r.url.toString()).toBe("https://agency-one.org/path?q=1");
    expect(reason("https://www.agency-one.org/a")).toBe("ok");
    expect(reason("https://deep.sub.agency-two.org/a")).toBe("ok");
    expect(reason("https://AGENCY-ONE.ORG:443/a")).toBe("ok");
  });

  it("normalises a trailing-dot host so the name used for SNI and Host matches the allow-list", () => {
    const r = checkUrl("https://agency-one.org./a", ALLOW);
    expect(r.ok && r.url.hostname).toBe("agency-one.org");
  });

  it("refuses everything when the allow-list is empty (the shipped default)", () => {
    expect(reason("https://agency-one.org/a", EMPTY_ALLOWLIST)).toBe("domain_not_allowlisted");
  });

  it.each([
    ["http://agency-one.org/a", "not_https"],
    ["ftp://agency-one.org/a", "not_https"],
    ["file:///etc/passwd", "not_https"],
    ["javascript:alert(1)", "not_https"],
    ["data:text/html,hi", "not_https"],
    ["//agency-one.org/a", "invalid_url"],
    ["agency-one.org/a", "invalid_url"],
    ["", "invalid_url"],
    ["https://user:pw@agency-one.org/a", "credentials_in_url"],
    ["https://agency-one.org@evil.invalid.net/a", "credentials_in_url"],
    ["https://agency-one.org:8443/a", "port_not_allowed"],
    ["https://agency-one.org:22/a", "port_not_allowed"],
  ])("rejects %s (%s)", (u, why) => expect(reason(u)).toBe(why));

  it.each([
    "https://127.0.0.1/a", "https://10.0.0.1/a", "https://169.254.169.254/latest/meta-data", "https://[::1]/a", "https://[fe80::1]/a",
    "https://[::ffff:127.0.0.1]/a", "https://2130706433/a", "https://0x7f.0.0.1/a", "https://0177.0.0.1/a", "https://127.1/a",
    "https://8.8.8.8/a",
  ])("rejects the IP literal or numeric host %s", (u) => expect(reason(u)).toBe("ip_literal_host"));

  it("refuses a host whose last label is numeric (the URL parser itself rejects it as an invalid IPv4)", () => {
    expect(reason("https://agency-one.org.1/a")).not.toBe("ok");
  });

  it.each([
    ["https://localhost/a", "single_label_host"],
    ["https://intranet/a", "single_label_host"],
    ["https://metadata.google.internal/a", "domain_not_allowlisted"],
    ["https://printer.local/a", "domain_not_allowlisted"],
    ["https://app.localhost/a", "reserved_host"],
    ["https://a.example.com/a", "reserved_host"],
    ["https://x.invalid/a", "reserved_host"],
  ])("rejects internal-looking name %s (%s)", (u, why) => expect(reason(u)).toBe(why));

  it("rejects lookalike hosts that merely contain or end with an allow-listed name", () => {
    for (const u of [
      "https://agency-one.org.evil.net/a", "https://evilagency-one.org/a", "https://agency-one.org-evil.net/a",
      "https://xn--gency-one-9bb.org/a", "https://agency-one.com/a", "https://agency-one.org.attacker.io/a",
    ]) expect(reason(u), u).toBe("domain_not_allowlisted");
  });

  it("rejects non-ASCII hosts after punycode folding (IDN homographs never match)", () => {
    expect(reason("https://аgency-one.org/a")).toBe("domain_not_allowlisted"); // Cyrillic a -> xn--
  });

  it("rejects over-long URLs and URLs with whitespace or control characters", () => {
    expect(reason(`https://agency-one.org/${"a".repeat(2100)}`)).toBe("too_long");
    expect(reason("https://agency-one.org/a b")).toBe("invalid_url");
    expect(reason("https://agency-one.org/a\nb")).toBe("invalid_url");
    expect(reason("https://agency-one.org/a\u0000b")).toBe("invalid_url");
    expect(reason(" https://agency-one.org/a")).toBe("invalid_url");
  });
});
