// IP address policy for the SSRF-safe fetcher. Fail closed: anything that is not a plain, publicly routable
// unicast address (including anything we cannot parse) is blocked.

/** [network, prefix length] for IPv4 ranges that must never be fetched. */
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255) || m.slice(1).some((o) => o.length > 1 && o.startsWith("0"))) return null; // no octal-looking forms
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

const inV4 = (ip: number, [net, bits]: [string, number]): boolean => {
  const n = parseIPv4(net)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((n & mask) >>> 0);
};

export function isBlockedIPv4(s: string): boolean {
  const ip = parseIPv4(s);
  return ip === null || BLOCKED_V4.some((r) => inV4(ip, r));
}

/** Parse an IPv6 literal into eight 16-bit groups, or null. Zone ids and malformed input return null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes("%") || s.includes("[") || !s.includes(":")) return null;
  let tail: number[] = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const n = parseIPv4(v4[1]);
    if (n === null) return null;
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, s.length - v4[1].length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  } else groups = head;
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isBlockedIPv6(s: string): boolean {
  const g = parseIPv6(s);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d): judged by the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIPv4(v4Of(g[6], g[7]));
  // Only global unicast 2000::/3 may be fetched; this excludes ::, ::1, ULA, link-local, multicast, NAT64, ...
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true; // ORCHID
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0020) return true; // ORCHIDv2
  if (g[0] === 0x2002) return isBlockedIPv4(v4Of(g[1], g[2])); // 6to4: judged by the embedded IPv4 address
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // documentation (3fff::/20)
  return false;
}

export function isBlockedIp(ip: string): boolean {
  return ip.includes(":") ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
}
