import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  profileCreationHitsRetainedForTests,
  profileCreationHitsSizeForTests,
  recordProfileCreationHitForTests,
  resetProfileCreationHitsForTests,
  sweepProfileCreationHitsForTests,
} from "../src/auth.js";

/**
 * Release-safety regressions (V1.0 hardening):
 *
 *   1. deploy-prod build-identity verification — the safety decision lives
 *      in scripts/lib/build-identity.sh and is executed here REAL, via bash:
 *      a mismatch, or a missing header, must exit non-zero; a matching build
 *      must pass. A stale image can never count as a successful deploy.
 *   2. deploy-prod.sh wiring contract — the script sources the lib and fails
 *      the deploy when verification rejects (grep-contract: the behavior
 *      itself is covered in 1).
 *   3. Anonymous-profile limiter retained-state cleanup — an IP whose hits
 *      are all expired disappears from the limiter's retained state.
 */
const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const LIB = join(repoRoot, "scripts", "lib", "build-identity.sh");

function runVerifier(expectedFull: string, expectedShort: string, observed: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("bash", [
      "-c",
      `source '${LIB}' && verify_build_identity "$1" "$2" "$3"`,
      "verify_build_identity",
      expectedFull,
      expectedShort,
      observed,
    ], { env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : (err ? 1 : 0), output: `${stdout}${stderr}` });
    });
  });
}

describe("build-identity verification (deploy-prod hard gate)", () => {
  it("accepts the exact deployed full SHA", async () => {
    const sha = "c150f71046534c871b9051ff684ecfc2834bb253";
    const res = await runVerifier(sha, sha.slice(0, 7), sha);
    expect(res.code).toBe(0);
  });

  it("accepts a short-form header match defensively", async () => {
    const sha = "c150f71046534c871b9051ff684ecfc2834bb253";
    const res = await runVerifier(sha, sha.slice(0, 7), sha.slice(0, 7));
    expect(res.code).toBe(0);
  });

  it("FAILS on a missing header (running build does not identify itself)", async () => {
    const res = await runVerifier("aaaaaaaaaa", "aaaaaaa", "");
    expect(res.code).not.toBe(0);
    expect(res.output).toContain("no x-tornscope-build header");
    expect(res.output).toContain("build --no-cache"); // remediation hint present
  });

  it("FAILS on build identity drift with expected + observed + remediation", async () => {
    const expected = "c150f71046534c871b9051ff684ecfc2834bb253";
    const observed = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const res = await runVerifier(expected, expected.slice(0, 7), observed);
    expect(res.code).not.toBe(0);
    expect(res.output).toContain(expected); // prints expected SHA
    expect(res.output).toContain(observed); // prints observed SHA
    expect(res.output).toContain("mismatch");
    expect(res.output).toContain("Remediation");
  });
});

describe("deploy-prod.sh hard-fail wiring (contract)", () => {
  const script = readFileSync(join(repoRoot, "scripts", "deploy-prod.sh"), "utf8");

  it("sources the verifier and exits non-zero when identity verification rejects", () => {
    expect(script).toContain("lib/build-identity.sh");
    expect(script).toContain("verify_build_identity");
    // The failure path must exit before any success line can print.
    const verifyIndex = script.indexOf("verify_build_identity \"$GIT_SHA\"");
    const failExit = script.indexOf("exit 1", verifyIndex);
    const okLine = script.indexOf("Production deploy OK");
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(failExit).toBeGreaterThan(verifyIndex);
    expect(okLine).toBeGreaterThan(failExit);
  });
});

describe("anonymous-profile limiter retained-state cleanup", () => {
  beforeEach(() => {
    resetProfileCreationHitsForTests();
  });

  afterAll(() => {
    resetProfileCreationHitsForTests();
  });

  it("an IP whose hits are all expired disappears from retained state", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      recordProfileCreationHitForTests("203.0.113.7");
      recordProfileCreationHitForTests("203.0.113.7");
      recordProfileCreationHitForTests("198.51.100.9");
      expect(profileCreationHitsRetainedForTests()).toBe(2);
      expect(profileCreationHitsSizeForTests()).toBe(2);

      // Advance past the 1h window: the two one-time visitor IPs are
      // physically removed from retained state — the map cannot grow with
      // addresses that never come back.
      vi.setSystemTime(1_700_000_000_000 + 2 * 3_600_000 + 1_000);
      recordProfileCreationHitForTests("203.0.113.8"); // fresh visitor
      const removed = sweepProfileCreationHitsForTests();
      expect(removed).toBe(2); // .7 and .9 physically dropped
      expect(profileCreationHitsRetainedForTests()).toBe(1); // only the fresh IP
      expect(profileCreationHitsSizeForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset clears retained state completely (test isolation)", () => {
    recordProfileCreationHitForTests("203.0.113.7");
    expect(profileCreationHitsSizeForTests()).toBe(1);
    resetProfileCreationHitsForTests();
    expect(profileCreationHitsSizeForTests()).toBe(0);
  });
});
