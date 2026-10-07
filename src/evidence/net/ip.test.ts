// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isBlockedIp, isBlockedIPv4, isBlockedIPv6, parseIPv4, parseIPv6 } from "./ip";

describe("IPv4 policy", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.88.99.1", "192.168.0.1",
    "192.168.255.255", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ])("blocks %s", (ip) => expect(isBlockedIPv4(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "169.253.1.1", "192.169.0.1", "198.20.0.1"])(
    "allows the public address %s", (ip) => expect(isBlockedIPv4(ip)).toBe(false));

  it.each(["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-4", "01.2.3.4", "1.2.3.04", "a.b.c.d", "1.2.3.4 ", "0x7f.0.0.1", "2130706433"])(
    "fails closed on malformed input %j", (ip) => expect(isBlockedIPv4(ip)).toBe(true));

  it("parses to a 32-bit value", () => {
    expect(parseIPv4("1.2.3.4")).toBe(0x01020304);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIPv4("999.0.0.1")).toBeNull();
  });
});

describe("IPv6 policy", () => {
  it.each([
    "::", "::1", "fe80::1", "fe80::abcd:1234", "febf::1", "fc00::1", "fd12:3456:789a::1", "ff02::1", "ff00::", "fec0::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:c0a8:101",
    "64:ff9b::7f00:1", "64:ff9b::8.8.8.8", "100::1", "2001:db8::1", "2001:db8:ffff::1", "2001::1", "2001:10::1", "2001:20::1",
    "2002:7f00:1::", "2002:0a00:0001::5", "2002:c0a8:0101::1", "3fff::1", "3fff:fff::1", "0:0:0:0:0:0:0:1", "::127.0.0.1",
  ])("blocks %s", (ip) => expect(isBlockedIPv6(ip)).toBe(true));

  it.each(["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "2002:0808:0808::1", "::ffff:8.8.8.8", "::ffff:808:808", "2400:cb00::1"])(
    "allows the public address %s", (ip) => expect(isBlockedIPv6(ip)).toBe(false));

  it.each(["", "not-an-ip", "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::1", "g::1", "fe80::1%eth0", "[::1]", "::ffff:999.1.1.1", "1:2:3:4:5:6:7"])(
    "fails closed on malformed input %j", (ip) => expect(isBlockedIPv6(ip)).toBe(true));

  it("parses compressed, expanded and embedded-IPv4 forms", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  });
});

describe("combined check", () => {
  it("dispatches on address family", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("garbage")).toBe(true);
  });
});
