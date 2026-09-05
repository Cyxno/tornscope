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
  repoUrl: "https://github.com/your-org/tornscope",
} as const;

export type Branding = typeof branding;
