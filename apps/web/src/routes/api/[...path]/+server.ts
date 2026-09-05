import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";

/**
 * Thin server-side proxy: forwards browser /api/* requests to the Fastify
 * backend. This keeps a single origin in every environment (vite dev,
 * adapter-node, Docker) so no CORS and no API exposure are needed.
 */
const handler: RequestHandler = async ({ request, params, url }) => {
  const base = env.API_BASE_URL ?? "http://localhost:3000";
  const target = new URL(`/api/${params.path ?? ""}`, base);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const proxied = await fetch(target, {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      accept: "application/json",
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });

  const text = await proxied.text();
  return new Response(text, {
    status: proxied.status,
    headers: { "content-type": proxied.headers.get("content-type") ?? "application/json" },
  });
};

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
export const PUT = handler;
