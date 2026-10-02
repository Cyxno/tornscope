/**
 * Build identity — the SINGLE canonical shape for "what am I running?".
 *
 * Version lives only in the root package.json (every workspace package
 * carries the same value); the git SHA arrives via the GIT_SHA build arg;
 * the environment label arrives via ENV_LABEL (e.g. "Development") with
 * "Production" as the default. No other place may format a
 * version/SHA/env triple — the API root + health payloads and the UI build
 * line all render `formatBuildIdentity(resolveBuildIdentity(...))`.
 */

export interface BuildIdentity {
  /** Semantic version from the root package.json (canonical source). */
  version: string;
  /** Full deployed git SHA ("dev" for local builds). */
  gitSha: string;
  /** Environment label: "Development" on non-public deployments, else
   *  "Production". */
  environment: string;
}

export function resolveBuildIdentity(input: { version?: string | null; gitSha?: string | null; environment?: string | null }): BuildIdentity {
  return {
    version: input.version?.trim() || "0.0.0-dev",
    gitSha: input.gitSha?.trim() || "dev",
    environment: input.environment?.trim() || "Production",
  };
}

/** First 7 chars of the SHA — enough to identify a build, safe to show. */
export function shortSha(gitSha: string): string {
  return gitSha.length > 7 ? gitSha.slice(0, 7) : gitSha;
}

/** "0.2.0-dev.0 · f63f466" — the canonical one-line build string. */
export function formatBuildIdentity(identity: BuildIdentity): string {
  return `${identity.version} · ${shortSha(identity.gitSha)}`;
}
