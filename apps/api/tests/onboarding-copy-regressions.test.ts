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

/* -------------------------------------------------------------------------- */
/* Live UX + semantics consistency pass                                       */
/* -------------------------------------------------------------------------- */

describe("demo UX", () => {
  const capabilities = read("../../web/src/lib/capabilities.ts");
  it("availabilityMessage renders demo copy instead of permission/stale complaints", () => {
    expect(capabilities).toContain("me.data?.isDemo");
    expect(capabilities).toContain("Synthetic example data");
  });

  it("sync page hides non-functional sync actions in demo", () => {
    expect(syncPage).toContain("!me.data?.isDemo");
  });
});

describe("xanax personal-cost semantics", () => {
  it("labels the consumption value as NOT personal spend and sponsored cost as $0", () => {
    expect(welcomeDrugsPage()).toContain("Estimated consumption value");
    expect(welcomeDrugsPage()).toContain("Personal cost $0");
    expect(welcomeDrugsPage()).toContain("Opening inventory — origin unknown");
    expect(welcomeDrugsPage()).not.toContain('label="Estimated spend"');
  });
  function welcomeDrugsPage(): string {
    return read("../../web/src/routes/drugs/+page.svelte");
  }
});

describe("labels and casing", () => {
  it("overview combat panel uses direction-aware labels", () => {
    expect(read("../../web/src/routes/+page.svelte")).toContain("Outgoing attacks");
    expect(read("../../web/src/routes/+page.svelte")).toContain("Successful defenses");
  });

  it("completed OC rows read 'You participated' for historical participation", () => {
    expect(read("../../web/src/routes/faction/+page.svelte")).toContain("You participated");
  });

  it("expired OC caption is grammatical", () => {
    const faction = read("../../web/src/routes/faction/+page.svelte");
    expect(faction).toContain("Crimes that expired or were cancelled");
    expect(faction).not.toContain("that expired or was cancelled");
  });

  it("OC completed table distinguishes Torn-reported cash from estimated total value", () => {
    const faction = read("../../web/src/routes/faction/+page.svelte");
    expect(faction).toContain("Est. total value");
    expect(faction).toContain("paid in items/respect");
    expect(faction).not.toContain("Reward cash");
  });
});

describe("document titles", () => {
  it("exactly one title per page: app.html has none (no duplicate-title bug) and pages set route-aware titles", () => {
    // A static app.html title rendered FIRST in <head>, so it won over the
    // per-page titles — app.html must contain no title element at all.
    expect(read("../../web/src/app.html")).not.toContain("<title>");
    for (const [path, expected] of [
      ["../../web/src/routes/+page.svelte", "Overview · TornScope"],
      ["../../web/src/routes/drugs/+page.svelte", "Drugs · TornScope"],
      ["../../web/src/routes/travel/+page.svelte", "Travel · TornScope"],
      ["../../web/src/routes/faction/+page.svelte", "Faction · TornScope"],
      ["../../web/src/routes/settings/+page.svelte", "Settings · TornScope"],
      ["../../web/src/routes/+error.svelte", "Error · TornScope"],
    ] as const) {
      expect(read(path)).toContain(`<title>${expected}</title>`);
    }
  });
});

describe("profile/browser wording", () => {
  it("uses linked-profile wording instead of one-browser-one-profile", () => {
    const welcome = read("../../web/src/routes/welcome/+page.svelte");
    expect(welcome).toContain("multiple browsers can link to the same TornScope profile");
    expect(welcome).toContain("a valid API key for the same Torn account");
    expect(welcome).not.toContain("your own server");
    const settings = read("../../web/src/routes/settings/+page.svelte");
    expect(settings).not.toContain("Per-user preferences arrive");
  });
});

describe("public beta presentation", () => {
  const header = read("../../web/src/lib/components/Header.svelte");
  const layout = read("../../web/src/routes/+layout.svelte");

  it("header shows a subtle persistent Beta badge beside the wordmark", () => {
    // Default (PUBLIC_ENV_LABEL unset — production) is the Beta chip.
    expect(header).toContain('|| "Beta"');
    expect(header).toContain("TornScope is in public beta");
    // Dev/staging deployments override the chip via PUBLIC_ENV_LABEL so a
    // staging instance can never pose as the public beta.
    expect(header).toContain("PUBLIC_ENV_LABEL");
  });

  it("footer marks Public Beta and links the maintainer safely", () => {
    expect(layout).toContain("Public Beta");
    expect(layout).toContain("maintained by");
    expect(layout).toContain('href="https://www.torn.com/profiles.php?XID=1816206"');
    expect(layout).toContain('target="_blank"');
    expect(layout).toContain('rel="noopener noreferrer"');
  });

  it("footer offers a Contact path (help / private deployment)", () => {
    expect(layout).toContain(">Contact</a>");
    expect(layout).toContain("private TornScope Docker deployment");
  });

  it("onboarding states the public beta status and expectations", () => {
    expect(welcome).toContain("Public Beta");
    expect(welcome).toContain("public beta");
    expect(welcome).toContain("actively");
  });

  it("welcome offers the private-deployment contact path", () => {
    expect(welcome).toContain("private TornScope Docker deployment");
    expect(welcome).toContain("Contact Cyxno on Torn");
    // External links must open safely.
    expect(welcome).toContain('rel="noopener noreferrer"');
  });

  it("settings hosts an About panel with release version and independence note", () => {
    expect(settings).toContain("About TornScope");
    expect(settings).toContain("Public Beta");
    expect(settings).toContain("branding.publicVersion");
    expect(settings).toContain("not operated, endorsed, or hosted by Torn");
    expect(settings).toContain("keep your own backups");
  });

  it("shared branding carries the real repository URL and beta version", () => {
    const brandingSrc = read("../../../packages/shared/src/branding.ts");
    expect(brandingSrc).toContain("https://github.com/Cyxno/tornscope");
    expect(brandingSrc).not.toContain("your-org");
    expect(brandingSrc).toContain('publicVersion: "v0.1.3 — Public Beta"');
  });
});
