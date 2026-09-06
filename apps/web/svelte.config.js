import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * CSP lives here — NOT in a hand-rolled hooks.server.ts header — because
 * SvelteKit must add the hash/nonce of its inline hydration bootstrap to
 * script-src itself. A static "script-src 'self'" header blocks that script,
 * so the app renders as static SSR HTML and never hydrates: every client-side
 * fetch (including /api/me on Settings) silently never runs.
 * style-src keeps 'unsafe-inline' for SvelteKit/ECharts inline style attributes.
 */
const cspDirectives = {
  "default-src": ["self"],
  "script-src": ["self"],
  "style-src": ["self", "unsafe-inline"],
  "img-src": ["self", "data:"],
  "font-src": ["self"],
  "connect-src": ["self"],
  "frame-ancestors": ["self"],
  "base-uri": ["self"],
  "form-action": ["self"],
};

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    csp: {
      directives: cspDirectives,
    },
  },
};

export default config;
