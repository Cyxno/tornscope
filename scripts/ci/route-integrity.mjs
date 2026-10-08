#!/usr/bin/env node
/**
 * Route integrity gate (v2.6.1 release-safety hardening).
 *
 * The v2.6.0 release failed CI because the /logs route page was never
 * committed: the root .gitignore rule `logs/` silently excluded the
 * routemap `apps/web/src/routes/logs/`. This gate makes that failure
 * class impossible to ship again:
 *
 *   1. ROUTE TRACKING — every SvelteKit route file (+page.svelte / +server.ts)
 *      found on disk under apps/web/src/routes must also be tracked by git
 *      (git ls-files). An ignored-but-on-disk route is a hard failure.
 *
 *   2. GITIGNORE COLLISION AUDIT — every tracked route file must NOT be
 *      matched by .gitignore (a tracked file that is also ignored will be
 *      silently dropped again the day it is re-added or renamed).
 *
 *   3. NAV INTEGRITY — every static absolute href ("/...") in any tracked
 *      .svelte file must resolve to a tracked route (exact page route, a
 *      dynamic-segment route prefix, or a tracked +server.ts API route).
 *
 * Usage: node scripts/ci/route-integrity.mjs   (exit 0 = pass, 1 = fail)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const routesDir = join(root, "apps", "web", "src", "routes");
const git = (args, opts = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...opts }).trim();

const problems = [];
const info = [];
const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

// ---- 1. Route tracking: disk vs git -----------------------------------------
const onDisk = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry === "+page.svelte" || entry === "+page.ts" || entry === "+page.js" || entry === "+server.ts") onDisk.push(full);
  }
};
if (!existsSync(routesDir)) die(`routes dir missing: ${relative(root, routesDir)}`);
else walk(routesDir);

const trackedFiles = git(["ls-files", "apps/web/src/routes"]).split("\n").filter(Boolean);
const trackedFilesIn = (rel) => git(["ls-files", rel]).split("\n").filter(Boolean).length > 0;
const routeKey = (p) => relative(root, p).split(sep).join("/");
const untracked = onDisk.map(routeKey).filter((f) => !trackedFiles.includes(f));
if (untracked.length > 0) {
  for (const f of untracked) die(`route file exists on disk but is NOT tracked by git (silent .gitignore drop?): ${f}`);
} else {
  info.push(`all ${onDisk.length} route files on disk are git-tracked`);
}

// ---- 2. .gitignore collision audit ------------------------------------------
const actuallyIgnored = [...trackedFiles].filter((f) => {
  try {
    execFileSync("git", ["check-ignore", "-q", f], { cwd: root, stdio: "pipe" });
    return true; // exit 0 = ignored
  } catch {
    return false;
  }
});
if (actuallyIgnored.length > 0) {
  for (const f of actuallyIgnored) die(`tracked route file matches .gitignore (collision — will silently vanish if re-added): ${f}`);
} else {
  info.push("no tracked route file collides with .gitignore");
}

// ---- 3. Nav href → tracked route integrity -----------------------------------
// Page routes: directory containing +page.svelte (root "/" included).
const pageRoutes = new Set(
  [...trackedFiles]
    .filter((f) => f.endsWith("+page.svelte"))
    .map((f) => {
      const dir = f.slice("apps/web/src/routes/".length, -"+page.svelte".length).replace(/\/$/, "");
      return "/" + dir;
    }),
);
// Route patterns (page + server) compiled to matchers: [param] eats one
// segment, [...rest] eats everything (SvelteKit semantics).
const apiRoutes = trackedFiles.filter((f) => f.endsWith("+server.ts"));
const routeMatchers = [
  ...[...pageRoutes, ...apiRoutes.map((f) => "/" + f.slice("apps/web/src/routes/".length, -"+server.ts".length))].map((route) => {
    const re = new RegExp(
      "^" +
        route
          .replace(/\/\[\.\.\.[^\]]+\]/g, "(?:/.*)?")
          .replace(/\/\[[^\]]+\]/g, "/[^/]+")
          .replace(/\/$/, "") +
        "/?$",
    );
    return { route, re };
  }),
];

const svelteFiles = git(["ls-files", "apps/web/src", "*.svelte"]).split("\n").filter((f) => f.endsWith(".svelte"));
const hrefRe = /href="(\/[^"{}]*)"/g;
let checked = 0;
for (const file of svelteFiles) {
  const text = readFileSync(join(root, file), "utf8");
  for (const m of text.matchAll(hrefRe)) {
    const href = m[1].replace(/[?#].*$/, "") || "/";
    checked++;
    if (!routeMatchers.some(({ re }) => re.test(href))) {
      die(`href "${href}" in ${file} has no tracked SvelteKit route (v2.6.0 /logs bug class)`);
    }
  }
}
// Nav config (apps/web/src/lib/nav.ts) carries the hrefs bound as
// href={item.href} in NavRail/MobileNav — static .svelte scanning alone
// misses them, so the config is checked explicitly.
const navConfigFiles = ["apps/web/src/lib/nav.ts"];
let navChecked = 0;
for (const file of navConfigFiles) {
  if (!trackedFilesIn(file)) die(`nav config not tracked by git: ${file}`);
  const text = readFileSync(join(root, file), "utf8");
  for (const m of text.matchAll(/href:\s*"(\/[^"]*)"/g)) {
    const href = m[1].replace(/[?#].*$/, "") || "/";
    navChecked++;
    if (!routeMatchers.some(({ re }) => re.test(href))) {
      die(`nav config href "${href}" in ${file} has no tracked SvelteKit route (v2.6.0 /logs bug class)`);
    }
  }
}
info.push(`${navChecked} nav-config href(s) in ${navConfigFiles.join(", ")} resolve to tracked routes`);

// Dynamic hrefs are not statically verifiable — count them so the gap stays visible.
let dynamicHrefs = 0;
for (const file of svelteFiles) {
  dynamicHrefs += (readFileSync(join(root, file), "utf8").match(/href=\{\//g) ?? []).length;
}
info.push(`${checked} static absolute href(s) across ${svelteFiles.length} tracked .svelte file(s) resolve to tracked routes`);
info.push(`${dynamicHrefs} dynamic href={…} expression(s) (not statically checkable — review manually when touched)`);

for (const line of info) console.log(`  ok: ${line}`);
if (process.exitCode) {
  console.error("\nROUTE INTEGRITY FAIL");
} else {
  console.log("ROUTE INTEGRITY PASS");
}
