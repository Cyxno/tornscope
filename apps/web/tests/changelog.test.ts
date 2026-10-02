import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANGELOG, CHANGELOG_KINDS, changelogReleases, entriesByKind } from "../src/lib/changelog";

/**
 * Changelog contracts (1.0.1): the page is built from ONE structured source
 * of REAL release history — annotated git tags + docs/RELEASE-NOTES-*.md.
 * These tests pin the data shape (latest first, real versions only), the
 * routing, and the navigation wiring on desktop (NavRail) and mobile
 * (MobileNav sheet).
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const page = read("../src/routes/changelog/+page.svelte");
const nav = read("../src/lib/nav.ts");
const icon = read("../src/lib/components/Icon.svelte");

describe("changelog data source", () => {
  it("represents the real release history — every annotated tag, no inventions", () => {
    const versions = CHANGELOG.map((r) => r.version);
    for (const required of ["v0.1.0-beta.1", "v0.1.1", "v0.1.3", "v1.0.0"]) {
      expect(versions, `missing release ${required}`).toContain(required);
    }
    // latest-first: the running (in-progress, not-yet-tagged) release leads
    expect(versions[0]).toBe("2.1.2");
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("is ordered newest-first by real release dates", () => {
    const dated = CHANGELOG.filter((r) => r.date !== undefined);
    for (let i = 1; i < dated.length; i++) {
      expect(Date.parse(dated[i - 1]!.date!), `${dated[i - 1]!.version} before ${dated[i]!.version}`).toBeGreaterThanOrEqual(
        Date.parse(dated[i]!.date!)
      );
    }
  });

  it("marks the running release as current and stages every release", () => {
    expect(CHANGELOG.filter((r) => r.current)).toHaveLength(1);
    expect(CHANGELOG.find((r) => r.current)?.version).toBe("2.1.2");
    for (const r of CHANGELOG) {
      expect(r.stage.length).toBeGreaterThan(0);
      expect(r.changes.length).toBeGreaterThan(0);
    }
  });

  it("only uses canonical change kinds, grouped in canonical order", () => {
    for (const release of CHANGELOG) {
      for (const change of release.changes) {
        expect(CHANGELOG_KINDS).toContain(change.kind);
      }
    }
    const grouped = entriesByKind(CHANGELOG[0]!);
    const kinds = grouped.map((g) => g.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => CHANGELOG_KINDS.indexOf(a) - CHANGELOG_KINDS.indexOf(b)));
  });

  it("exposes the history through the public helper", () => {
    expect(changelogReleases()).toBe(CHANGELOG);
  });
});

describe("changelog page + navigation", () => {
  it("the route renders from the structured source (no duplicated release text)", () => {
    expect(page).toContain("changelogReleases()");
    expect(page).toContain("entriesByKind(release)");
    // Release text lives ONLY in lib/changelog.ts — the page must not
    // hardcode release narratives.
    expect(page).not.toMatch(/v1\.0\.0|v0\.1\.3|beta\.1/);
  });

  it("navigation entry exists for desktop rail and mobile sheet", () => {
    expect(nav).toContain('{ href: "/changelog", label: "Changelog", icon: "changelog", group: "system" }');
    expect(icon).toContain("| \"changelog\"");
    expect(icon).toMatch(/changelog: "M/);
  });

  it("the page fits The Ledger header pattern and is responsive-first", () => {
    expect(page).toContain("<PageHeader");
    // Mobile-first stacking with a two-column grouping from md up.
    expect(page).toContain("md:grid-cols-2");
  });
});
