import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for URL ingest: every host the URL extractor connects to (the first URL and each
 * redirect hop) must resolve only to public unicast addresses. Loopback, private (RFC 1918, ULA),
 * link-local (incl. the cloud metadata address 169.254.169.254), unspecified, CGNAT, multicast,
 * reserved and IPv4-mapped/-compatible IPv6 forms of those are refused.
 *
 * The user (never the model) can opt out for local development with `VS_ALLOW_PRIVATE_URLS=1`
 * in the engine's environment.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it maps to (tests inject a fake). */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultLookup: LookupFn = async (hostname) => {
  const list = await dnsLookup(hostname, { all: true, verbatim: true });
  return list.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Env switch (set by the user in the engine's environment) that disables the guard. */
export const ALLOW_PRIVATE_URLS_ENV = "VS_ALLOW_PRIVATE_URLS";

export function allowPrivateUrls(env: Record<string, string | undefined> | undefined): boolean {
  return env?.[ALLOW_PRIVATE_URLS_ENV] === "1";
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}

/** [network, prefix] pairs of IPv4 ranges that must never be fetched. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network", incl. unspecified 0.0.0.0
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([net, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = v4ToInt(net);
    return n >= start && n < start + size;
  });
}

/** Expand an IPv6 literal (optionally with an embedded dotted IPv4 tail) to 8 hextets. */
function expandV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4ToInt(tail[1]!);
    s = `${s.slice(0, -tail[1]!.length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const [head, rest] = halves as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const a = parse(head);
  const b = rest === undefined ? [] : parse(rest);
  const fill = 8 - a.length - b.length;
  if (fill < 0 || (rest === undefined && fill !== 0)) return undefined;
  const out = [...a, ...new Array<number>(fill).fill(0), ...b];
  return out.length === 8 && out.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? out : undefined;
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true; // unparseable: refuse
  const v4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  const zeros5 = h.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d (incl. :: and ::1): judge the IPv4.
  if (zeros5 && h[5] === 0xffff) return isBlockedV4(v4(h[6]!, h[7]!));
  if (zeros5 && h[5] === 0) {
    if (h[6] === 0) return true; // ::, ::1 and ::/112
    return isBlockedV4(v4(h[6]!, h[7]!));
  }
  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address too.
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isBlockedV4(v4(h[6]!, h[7]!));
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True when `ip` is loopback, private, link-local, unspecified, CGNAT, multicast or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v = isIP(bare.split("%")[0]!);
  if (v === 4) return isBlockedV4(bare);
  if (v === 6) return isBlockedV6(bare);
  return true; // not an IP address at all: never treat it as safe
}

export class BlockedAddressError extends Error {
  constructor(
    readonly url: string,
    readonly host: string,
    readonly ip: string,
  ) {
    super(`refusing to fetch ${url}: ${host} resolves to a private or local address (${ip}). Set ${ALLOW_PRIVATE_URLS_ENV}=1 in the engine's environment to allow local URLs.`);
    this.name = "BlockedAddressError";
  }
}

export interface HostCheckOptions {
  /** Resolver; when absent, only literal IPs and `localhost` names are checked (no DNS). */
  lookup?: LookupFn;
  allowPrivate?: boolean;
}

/**
 * Validate the host of `url`. Returns the resolved addresses (all public) so the caller can pin
 * the connection to them, or `undefined` when nothing was resolved (literal public IP handled by
 * the caller's connect; no lookup given).
 */
export async function checkUrlHost(url: URL, opts: HostCheckOptions): Promise<ResolvedAddress[] | undefined> {
  if (opts.allowPrivate) return undefined;
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const literal = isIP(host);
  if (literal) {
    if (isPrivateAddress(host)) throw new BlockedAddressError(url.href, url.hostname, host);
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) throw new BlockedAddressError(url.href, url.hostname, "localhost");
  if (!opts.lookup) return undefined;
  const addrs = await opts.lookup(host);
  if (addrs.length === 0) throw new Error(`${host} did not resolve to any address`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new BlockedAddressError(url.href, url.hostname, a.address);
  }
  return addrs;
}
