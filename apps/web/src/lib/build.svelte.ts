import { browser } from "$app/environment";
import { formatBuildIdentity, resolveBuildIdentity } from "@tornscope/shared";

/**
 * Build identity for the UI (roadmap #9): version · short SHA, resolved
 * once from the unauthenticated health endpoint (never creates a session),
 * rendered by the nav rail and Settings so a deployed build is always
 * identifiable on-screen.
 */
export const build = $state({ text: "" });

let requested = false;
export function loadBuildIdentity(fetcher: typeof fetch = fetch): void {
  // Browser-only: the relative /api/health URL has no meaning during SSR,
  // and the client re-runs this after hydration.
  if (!browser || requested || build.text) return;
  requested = true;
  fetcher("/api/health")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j?.version) return;
      build.text = formatBuildIdentity(resolveBuildIdentity({ version: j.version, gitSha: j.gitSha, environment: j.environment }));
    })
    .catch(() => undefined);
}
