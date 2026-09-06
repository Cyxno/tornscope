import type { Handle } from "@sveltejs/kit";

/**
 * Security headers for every page and proxied API response.
 *
 * CSP notes:
 * - scripts are external bundles (adapter-node) -> script-src 'self'
 * - SvelteKit/ECharts apply inline style attributes -> style-src needs
 *   'unsafe-inline' (scripts stay locked down)
 * - connect-src 'self' covers the same-origin /api proxy
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set("Content-Security-Policy", CSP);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  return response;
};
