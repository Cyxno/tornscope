import type { Handle } from "@sveltejs/kit";

/**
 * Security headers for every page and proxied API response.
 *
 * The Content-Security-Policy header is intentionally NOT set here: it is
 * configured in svelte.config.js (kit.csp) so SvelteKit can add the
 * hash/nonce of its inline hydration bootstrap script to script-src. A
 * static header here would stack with SvelteKit's and their intersection
 * would block hydration again. All other hardening headers stay below.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  return response;
};
