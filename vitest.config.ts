import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@tornscope\/shared$/, replacement: r("./packages/shared/src/index.ts") },
      { find: /^@tornscope\/analytics$/, replacement: r("./packages/analytics/src/index.ts") },
      { find: /^@tornscope\/torn-api$/, replacement: r("./packages/torn-api/src/index.ts") },
      { find: /^@tornscope\/database$/, replacement: r("./packages/database/src/index.ts") },
      { find: /^@tornscope\/ui$/, replacement: r("./packages/ui/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
    ],
    // Database/Redis integration tests are skipped unless services are reachable.
    testTimeout: 15000,
    // Defaults for DB-backed suites: the modules they import read
    // encryption/rate-limit env at load time, before test-file bodies run.
    setupFiles: ["./vitest.setup.ts"],
  },
});
