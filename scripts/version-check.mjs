#!/usr/bin/env node
/**
 * TornScope version + toolchain coherence check (V1.0 hardening).
 *
 * One authoritative validator so release tooling (release-preflight.sh) and
 * humans check the same things:
 *
 *   1. VERSION COHERENCE — the root package.json version is canonical; every
 *      workspace package must match it exactly. (The actual release version
 *      bump happens during release engineering; this check only proves the
 *      tree is internally consistent whatever the version is.)
 *
 *   2. PACKAGE-MANAGER COHERENCE — the root package.json `packageManager`
 *      field is the single pnpm pin. Dockerfiles (corepack prepare) and the
 *      GitHub Actions workflow must use the same version, so a lockfile can
 *      never be resolved by two different pnpm majors.
 *
 * Usage: node scripts/version-check.mjs [--json]
 * Exits 0 when coherent; 1 with a human-readable problem list otherwise.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const problems = [];
const info = [];

// ---- 1. Version coherence -------------------------------------------------
const rootPkg = read("package.json");
const workspacePaths = [
  "apps/api",
  "apps/web",
  "apps/worker",
  "packages/shared",
  "packages/analytics",
  "packages/database",
  "packages/torn-api",
  "packages/ui",
];
const mismatched = workspacePaths.filter((p) => read(`${p}/package.json`).version !== rootPkg.version);
if (mismatched.length > 0) {
  problems.push(`version mismatch with root ${rootPkg.version}: ${mismatched.join(", ")}`);
} else {
  info.push(`all 9 package versions == ${rootPkg.version}`);
}

// ---- 2. Package-manager coherence ------------------------------------------
const packageManager = rootPkg.packageManager ?? "";
const pinMatch = /^pnpm@(\d+\.\d+\.\d+)(\+.*)?$/.exec(packageManager);
if (!pinMatch) {
  problems.push(`root package.json missing a "packageManager": "pnpm@<exact-version>" pin (found: ${JSON.stringify(packageManager)})`);
}
const pnpmPin = pinMatch?.[1];

if (pnpmPin) {
  const dockerfiles = ["docker/api.Dockerfile", "docker/web.Dockerfile", "docker/worker.Dockerfile"];
  for (const df of dockerfiles) {
    const text = readFileSync(join(root, df), "utf8");
    if (!text.includes(`pnpm@${pnpmPin}`)) {
      problems.push(`${df} does not prepare pnpm@${pnpmPin} (packageManager pin drift)`);
    }
  }

  const ciPath = join(root, ".github", "workflows", "ci.yml");
  const ci = readFileSync(ciPath, "utf8");
  // Tolerates comment lines between `with:` and the `version:` key.
  const ciVersion = /pnpm\/action-setup@v\d+[\s\S]*?version:\s*(\S+)/.exec(ci)?.[1];
  if (!ciVersion) {
    problems.push(".github/workflows/ci.yml does not pin a pnpm version for pnpm/action-setup");
  } else if (ciVersion !== pnpmPin) {
    problems.push(`CI pnpm ${ciVersion} != packageManager pin ${pnpmPin}`);
  }

  // Lockfile must be readable by the pinned major.
  const lockfileMajor = parseInt(readFileSync(join(root, "pnpm-lock.yaml"), "utf8").match(/lockfileVersion:\s*'([^'.]+)/)?.[1] ?? "0", 10);
  const pnpmMajor = parseInt(pnpmPin.split(".")[0], 10);
  if (!(pnpmMajor >= 9 && lockfileMajor === 9)) {
    problems.push(`pnpm-lock.yaml lockfileVersion ${lockfileMajor} is not known to work with pnpm ${pnpmMajor}`);
  }
  if (problems.length === 0) info.push(`pnpm ${pnpmPin} coherent across package.json, Dockerfiles and CI (lockfile v${lockfileMajor})`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: problems.length === 0, version: rootPkg.version, pnpm: pnpmPin, problems, info }, null, 2));
} else {
  for (const line of info) console.log(`  ok: ${line}`);
  for (const line of problems) console.error(`  FAIL: ${line}`);
}

if (problems.length > 0) process.exit(1);
