/**
 * Push-endpoint validation (SSRF guard).
 *
 * A Web Push subscription's `endpoint` is an HTTPS URL the server later POSTs
 * to via web-push. Browsers generate real endpoints only on major push
 * services (fcm.googleapis.com, updates.push.services.mozilla.com,
 * api.push.apple.com, notify.windows.com — all HTTPS, port 443), but the API
 * accepts arbitrary client input: without validation a user could register an
 * endpoint pointing at loopback, the Docker network, RFC1918 space or a
 * cloud-metadata address, and every push send would become a server-side
 * request into the internal network.
 *
 * Validation is purely LOCAL (string parsing + IP-range checks): no DNS
 * lookup, no network request. A hostname that merely RESOLVES to an internal
 * address cannot be caught without a network request — that residual risk is
 * accepted, and documented for operators (push endpoints are validated
 * structurally, not resolved).
 *
 * Deliberately NOT a hostname denylist of push providers: any HTTPS, port-443,
 * public-looking URL passes, so a new push provider works without an app
 * update; only structurally unsafe endpoints are rejected.
 */

export interface PushEndpointGuard {
  allowed: boolean;
  /** Human-readable reason for rejections (safe to show to the client). */
  reason?: string;
}

const INTERNAL_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"] as const;

/** IPv4-in-private/loopback/link-local/unspecified space. */
function isPrivateIPv4(ip: string): boolean {
  const bits = ip.split(".").map(Number);
  if (bits.length !== 4 || bits.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return false;
  const [a, b] = bits as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC1918, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** IPv6 in loopback/unspecified/link-local/unique-local/IPv4-mapped space. */
function isPrivateIPv6(raw: string): boolean {
  const addr = raw.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase(); // strip brackets + zone id
  if (addr === "::" || addr === "::1") return true;
  if (addr.startsWith("fe8") || addr.startsWith("fe9") || addr.startsWith("fea") || addr.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped ::ffff:a.b.c.d — the URL parser canonicalizes the dotted form
  // into hex (::ffff:7f00:1), so handle both spellings.
  const mappedDotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]!);
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // embedded IPv4 form ::a.b.c.d
  const embedded = addr.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isPrivateIPv4(embedded[1]!);
  return false;
}

function isInternalHostname(hostname: string): boolean {
  const name = hostname.replace(/\.$/, "").toLowerCase(); // strip trailing FQDN dot
  if (name === "localhost") return true;
  if (INTERNAL_HOSTNAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // Single-label hostnames ("intranet") can only ever resolve on an internal
  // DNS/search-domain — no public push service is a single label.
  if (!name.includes(".")) return true;
  return false;
}

/**
 * Validate a client-supplied push endpoint. Returns a reason string for
 * user-facing errors when rejected.
 */
export function checkPushEndpoint(raw: string): PushEndpointGuard {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "The push endpoint is not a valid URL." };
  }

  // 1. Browsers only ever subscribe on HTTPS push services; plain HTTP would
  //    turn every push send into a cleartext request we cannot authenticate.
  if (url.protocol !== "https:") {
    return { allowed: false, reason: "Push endpoints must use HTTPS." };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: "Push endpoints must not contain credentials." };
  }
  // 2. Legit push services always serve on 443 — any other port would allow
  //    probing internal services on odd ports.
  if (url.port !== "" && url.port !== "443") {
    return { allowed: false, reason: "Push endpoints must use the default HTTPS port." };
  }

  // WHATWG URL keeps IPv6 literals bracketed in .hostname — isPrivateIPv6
  // strips them.
  const hostname = url.hostname;
  if (hostname.includes(":")) {
    // IPv6 literal
    if (isPrivateIPv6(hostname)) {
      return { allowed: false, reason: "Push endpoints must not point at private or local addresses." };
    }
  } else if (/^(\d+\.){3}\d+$/.test(hostname)) {
    // IPv4 literal
    if (isPrivateIPv4(hostname)) {
      return { allowed: false, reason: "Push endpoints must not point at private or local addresses." };
    }
  } else if (isInternalHostname(hostname)) {
    return { allowed: false, reason: "Push endpoints must not point at local addresses." };
  }

  return { allowed: true };
}
