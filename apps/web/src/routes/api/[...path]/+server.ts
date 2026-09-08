import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";

/**
 * Thin server-side proxy: forwards browser /api/* requests to the Fastify
 * backend. This keeps a single origin in every environment (vite dev,
 * adapter-node, Docker) so no CORS and no API exposure are needed.
 *
 * The session cookie is the authentication mechanism, so cookies MUST
 * survive the proxy in both directions:
 * - the browser's Cookie header reaches the API;
 * - the API's Set-Cookie (session creation) reaches the browser;
 * - the forwarded protocol is passed through so the API can mark the
 *   session cookie Secure only when the public origin is HTTPS.
 */

/**
 * The client address forwarded to the API, which keys its per-IP rate
 * limits (and the anonymous-profile creation limiter) on it.
 *
 * Default: the socket address of the direct peer — correct for localhost
 * development and direct LAN access. Behind a reverse proxy the socket peer
 * is the proxy itself, so the operator configures the header that carries
 * the REAL client IP:
 * - `CLIENT_IP_HEADER=x-forwarded-for` with `CLIENT_IP_DEPTH=1` for a single
 *   proxy hop (e.g. Nginx Proxy Manager): depth counts how many proxies
 *   appended to the chain, so the value that many entries from the RIGHT is
 *   the browser address and a client-spoofed entry is ignored;
 * - `CLIENT_IP_HEADER=cf-connecting-ip` when Cloudflare is in front.
 *
 * adapter-node's own ADDRESS_HEADER is deliberately not used here: once set
 * it is mandatory on EVERY request, so direct LAN access (no proxy header)
 * would fail the /api proxy. This resolution falls back to the socket
 * address instead.
 */
function clientAddressForApi(headers: Headers, socketAddress: () => string): string {
  const header = (env.CLIENT_IP_HEADER ?? "").trim().toLowerCase();
  if (header) {
    const raw = headers.get(header);
    if (raw) {
      const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
      if (header === "x-forwarded-for") {
        const depth = Math.max(1, Number.parseInt(env.CLIENT_IP_DEPTH ?? "1", 10) || 1);
        const picked = values[values.length - depth];
        if (picked) return picked;
      } else if (values.length > 0) {
        return values[values.length - 1];
      }
    }
  }
  try {
    return socketAddress();
  } catch {
    // socketAddress() throws if adapter-node's ADDRESS_HEADER is configured
    // but absent from the request. Rate limiting degrades to one shared
    // bucket rather than the /api proxy failing outright.
    return "unknown";
  }
}

const handler: RequestHandler = async ({ request, params, url, getClientAddress }) => {
  const base = env.API_BASE_URL ?? "http://localhost:3000";
  // Re-encode each segment: a path like /api/%2e%2e/ must not normalize into
  // a different target on the API side.
  const safePath = (params.path ?? "")
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
  const target = new URL(`/api/${safePath}`, base);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;
  // Body-less mutations (DELETE, payload-free POST) must NOT carry a
  // content-type: the backend's JSON parser would reject the empty body
  // ("Body cannot be empty when content-type is set"). Only attach one when
  // there is an actual body to describe.
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  if (body) headers["content-type"] = request.headers.get("content-type") ?? "application/json";
  // The API is a trusted single hop behind THIS proxy: forward the real
  // client address so per-IP rate limits key on actual visitors, not on the
  // web container's IP (all visitors would otherwise share one bucket).
  headers["x-forwarded-for"] = clientAddressForApi(request.headers, getClientAddress);
  // Let the API see how the browser reached us (https or not). Prefer the
  // proto from the trusted reverse proxy (NPM sends X-Forwarded-Proto:
  // https) over the SvelteKit-resolved URL — the session cookie's Secure
  // flag depends on this distinction.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  headers["x-forwarded-proto"] = forwardedProto ?? url.protocol.replace(":", "");
  if (url.host) headers["x-forwarded-host"] = url.host;
  const origin = request.headers.get("origin");
  if (origin) headers.origin = origin;

  const proxied = await fetch(target, {
    method: request.method,
    headers,
    body,
  });

  const responseHeaders = new Headers({ "content-type": proxied.headers.get("content-type") ?? "application/json" });
  // Multiple Set-Cookie headers must all be forwarded (getSetCookie keeps them).
  for (const cookieHeader of proxied.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookieHeader);
  }
  const cacheControl = proxied.headers.get("cache-control");
  if (cacheControl) responseHeaders.set("cache-control", cacheControl);
  else responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-tornscope-build", proxied.headers.get("x-tornscope-build") ?? "");

  const text = await proxied.text();
  return new Response(text, { status: proxied.status, headers: responseHeaders });
};

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
export const PUT = handler;
