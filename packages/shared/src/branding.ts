/**
 * Branding lives here so the product name can be replaced in one place.
 * Never hardcode "TornScope" in feature code - import from this module.
 *
 * Keep this module free of Node globals (process.env etc.): it is imported
 * by browser bundles, where those globals do not exist.
 */
export const branding = {
  appName: "TornScope",
  tagline: "Torn analytics & history portal",
  repoUrl: "https://github.com/Cyxno/tornscope",
  /**
   * Public release version shown in the product (About panel, onboarding).
   * Must match the release tag this main branch is preparing; bump together
   * with the root package.json version.
   */
  publicVersion: "v0.1.0-beta.1",
} as const;

export type Branding = typeof branding;
