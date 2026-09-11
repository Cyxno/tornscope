import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Compose environment consistency (roadmap #9, phase 16).
 *
 * Regression guard for the class of bug where one service misses env vars
 * another has (the VAPID-on-api-only incident: the worker silently never
 * received push keys). Parses every compose variant and asserts the
 * shared-critical variables exist on BOTH the api and worker services, and
 * that the sandboxing/security options are uniform across app services.
 */

const composeFiles = ["docker-compose.yml", "docker-compose.dev.yml", "docker-compose.unraid.yml"] as const;

/** Extract a service's block (regex, not YAML — the compose files are flat
 *  and conventionally formatted). */

function serviceBlock(content: string, service: string): string {
  const start = content.search(new RegExp(`^ {2}${service}:\\n`, "m"));
  if (start === -1) return "";
  const rest = content.slice(start);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function serviceEnvKeys(content: string, service: string): string[] {
  const block = serviceBlock(content, service);
  if (!block) return [];
  const envKeys: string[] = [];
  let inEnvironment = false;
  for (const line of block.split("\n")) {
    if (/^ {4}environment: *$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment) {
      if (/^ {6}\S/.test(line)) {
        const key = line.trim().split(":")[0];
        if (key && !key.startsWith("#")) envKeys.push(key);
      } else if (/\S/.test(line)) {
        inEnvironment = false;
      }
    }
  }
  return envKeys;
}

function serviceHas(content: string, service: string, needle: string): boolean {
  return serviceBlock(content, service).includes(needle);
}

describe("compose env consistency", () => {
  const SHARED_CRITICAL = [
    "DATABASE_URL",
    "REDIS_URL",
    "API_KEY_ENCRYPTION_KEY",
    "TORN_API_BASE_URL",
    "TORN_API_MIN_REQUEST_INTERVAL_MS",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_SUBJECT",
    "ENV_LABEL",
    "GIT_SHA",
  ];

  for (const file of composeFiles) {
    it(`${file}: api and worker share every critical variable (no VAPID-style gap)`, () => {
      const content = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), "utf8");
      const api = serviceEnvKeys(content, "api");
      const worker = serviceEnvKeys(content, "worker");
      expect(api.length, "api service env block parsed").toBeGreaterThan(5);
      expect(worker.length, "worker service env block parsed").toBeGreaterThan(5);
      // GIT_SHA flows as a BUILD ARG (baked identity), not runtime env.
      const apiArgs = serviceBlock(content, "api").includes("GIT_SHA:");
      const workerArgs = serviceBlock(content, "worker").includes("GIT_SHA:");
      expect(apiArgs, `${file}: api build receives GIT_SHA`).toBe(true);
      expect(workerArgs, `${file}: worker build receives GIT_SHA`).toBe(true);
      for (const key of SHARED_CRITICAL.filter((k) => k !== "GIT_SHA")) {
        expect(api, `${file}: api has ${key}`).toContain(key);
        expect(worker, `${file}: worker has ${key}`).toContain(key);
      }
    });

    it(`${file}: app services carry the runtime sandbox`, () => {
      const content = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), "utf8");
      for (const service of ["api", "worker", "web"]) {
        expect(serviceHas(content, service, "no-new-privileges:true"), `${service} no-new-privileges`).toBe(true);
        expect(serviceHas(content, service, "- ALL"), `${service} cap_drop ALL`).toBe(true);
        expect(serviceHas(content, service, "read_only: true"), `${service} read_only`).toBe(true);
      }
    });
  }

  it("root package.json is the only version source (workspace packages match)", () => {
    const root = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")).version as string;
    for (const p of ["apps/api", "apps/web", "apps/worker", "packages/shared", "packages/analytics", "packages/database", "packages/torn-api", "packages/ui"]) {
      const version = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${p}/package.json`, import.meta.url)), "utf8")).version as string;
      expect(version, `${p}/package.json version matches root`).toBe(root);
    }
  });
});
