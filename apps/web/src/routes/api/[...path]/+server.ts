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
const handler: RequestHandler = async ({ request, params, url }) => {
  const base = env.API_BASE_URL ?? "http://localhost:3000";
  const target = new URL(`/api/${params.path ?? ""}`, base);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const headers: Record<string, string> = {
    "content-type": request.headers.get("content-type") ?? "application/json",
    accept: "application/json",
  };
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;
  // Let the API see how the browser reached us (https or not).
  headers["x-forwarded-proto"] = url.protocol.replace(":", "");
  if (url.host) headers["x-forwarded-host"] = url.host;
  const origin = request.headers.get("origin");
  if (origin) headers.origin = origin;

  const proxied = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
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
