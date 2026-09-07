import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Copy-level regression guards for the onboarding trust model and the
 * removal of owner-facing product features. These read the route sources
 * directly: they verify what is (and is NOT) rendered to users — the
 * operator disclosure, the independence-from-Torn wording, the operator
 * link, and the absence of every legacy owner/admin UI element.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const welcome = read("../../web/src/routes/welcome/+page.svelte");
const settings = read("../../web/src/routes/settings/+page.svelte");
const syncPage = read("../../web/src/routes/sync/+page.svelte");

describe("onboarding trust wording", () => {
  it("states TornScope is independent from Torn, not hosted or operated by Torn", () => {
    expect(welcome).toContain("independent from Torn");
    expect(welcome).toContain("not hosted or operated by Torn");
  });

  it("discloses the honest decryption reality", () => {
    expect(welcome).toContain("The server must decrypt your API key whenever TornScope contacts Torn on your behalf");
    expect(welcome).toContain("the person operating this TornScope server can technically access the data your key permits");
  });

  it("names the operator Cyxno with a safe external profile link", () => {
    expect(welcome).toContain("This server is operated by");
    expect(welcome).toContain('href="https://www.torn.com/profiles.php?XID=1816206"');
    // Opened safely: new tab with noopener/noreferrer.
    expect(welcome).toContain('target="_blank"');
    expect(welcome).toContain('rel="noopener noreferrer"');
    // No endorsement implication.
    expect(welcome).toContain("does not endorse, host or operate TornScope");
  });

  it("keeps the self-hosting note as secondary copy", () => {
    expect(welcome).toContain("Self-hosting TornScope yourself gives you the strongest control over your data");
  });

  it("keeps Limited as a valid privacy-first choice", () => {
    expect(welcome).toContain("privacy-first");
    expect(welcome).toContain("Full Access can expose considerably more private Torn activity");
  });
});

describe("owner/admin product surface removal", () => {
  it("settings has no server administration panel and no infrastructure content", () => {
    expect(settings).not.toContain("Server administration");
    expect(settings).not.toContain("Unraid");
    expect(settings).not.toContain("pg_dump");
    expect(settings).not.toContain("docker compose");
    expect(settings).not.toContain("isServerOwner");
    expect(settings).not.toContain("ownerBindAvailable");
    expect(settings).not.toContain("Legacy owner binding");
  });

  it("build SHA is not displayed anywhere in user pages", () => {
    expect(settings).not.toContain("build.commit");
    expect(syncPage).not.toContain("build.commit");
    expect(syncPage).not.toContain("Deployed build");
  });

  it("sync page shows no infrastructure topology (system health, queues, heartbeat)", () => {
    expect(syncPage).not.toContain("health.system");
    expect(syncPage).not.toContain("health.queues");
    expect(syncPage).not.toContain("PostgreSQL");
    expect(syncPage).not.toContain("server owner");
  });

  it("no bind-owner action remains in the browser client", () => {
    const client = read("../../web/src/lib/api.ts");
    expect(client).not.toContain("bind-owner");
    expect(client).not.toContain("bindOwner");
  });
});
