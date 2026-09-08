import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for Web Push: resolve the endpoint hostname immediately BEFORE
 * the outbound send and reject if any resolved address is private/internal.
 *
 * TOCTOU note: pure userspace validation cannot fully prevent DNS rebinding
 * (the HTTP client performs its own resolution). This check closes the
 * trivial SSRF path; container/network-level egress rules are the
 * complementary defense.
 */

const PRIVATE_RANGES: Array<{ prefix: string; bits: number; label: string }> = [
  { prefix: "127.0.0.0", bits: 8, label: "loopback" },
  { prefix: "10.0.0.0", bits: 8, label: "RFC1918 private" },
  { prefix: "172.16.0.0", bits: 12, label: "RFC1918 private" },
  { prefix: "192.168.0.0", bits: 16, label: "RFC1918 private" },
  { prefix: "169.254.0.0", bits: 16, label: "link-local" },
  { prefix: "0.0.0.0", bits: 8, label: "unspecified" },
  { prefix: "100.64.0.0", bits: 10, label: "CGNAT shared" },
  { prefix: "fc00::", bits: 7, label: "IPv6 ULA" },
  { prefix: "fe80::", bits: 10, label: "IPv6 link-local" },
  { prefix: "::1", bits: 128, label: "IPv6 loopback" },
];

function ipToBigInt(ip: string): bigint {
  if (ip.includes(":")) {
    // IPv6: expand and convert to bigint
    const parts = ip.split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    let result = 0n;
    for (const g of groups) result = (result << 16n) | BigInt(parseInt(g || "0", 16));
    return result;
  }
  // IPv4: convert to bigint via 4 octets
  const octets = ip.split(".").map(Number);
  return BigInt(octets[0] ?? 0) * 256n ** 3n + BigInt(octets[1] ?? 0) * 256n ** 2n + BigInt(octets[2] ?? 0) * 256n + BigInt(octets[3] ?? 0);
}

function prefixToBigInt(prefix: string, bits: number): bigint {
  const base = ipToBigInt(prefix);
  // For IPv4 with bits 8-16, we need the full 32-bit mask
  const totalBits = prefix.includes(":") ? 128 : 32;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(totalBits - bits);
  return base & mask;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true; // not a valid IP
  // IPv4-mapped IPv6 (::ffff:10.0.0.1 etc.)
  if (ip.toLowerCase().startsWith("::ffff:")) {
    return isPrivateAddress(ip.slice(7));
  }
  const addr = ipToBigInt(ip);
  const totalBits = version === 6 ? 128 : 32;
  for (const range of PRIVATE_RANGES) {
    const rangeVersion = range.prefix.includes(":") ? 6 : 4;
    if (rangeVersion !== version) continue;
    const masked = addr >> BigInt(totalBits - range.bits);
    const rangeMasked = prefixToBigInt(range.prefix, range.bits) >> BigInt(totalBits - range.bits);
    if (masked === rangeMasked) return true;
  }
  return false;
}

/**
 * Resolve the endpoint's hostname and verify ALL resolved addresses are
 * public. Throws on private/unresolvable. Called immediately before the
 * outbound push send.
 */
export async function assertPublicEndpoint(endpoint: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    throw new Error("Invalid push endpoint URL");
  }
  // Literal IPs: check directly.
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`Push endpoint resolves to private address (${hostname})`);
    }
    return;
  }
  // DNS hostname: resolve all address families.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Push endpoint hostname unresolvable: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new Error(`Push endpoint hostname unresolvable: ${hostname}`);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr.address)) {
      throw new Error(`Push endpoint resolves to private address (${addr.address})`);
    }
  }
}
