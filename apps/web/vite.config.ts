import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      // Dev proxy: browser talks to Vite, Vite forwards /api to Fastify.
      "/api": {
        target: process.env.API_BASE_URL ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
