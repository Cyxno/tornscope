import type { FeatureAvailabilityDto, KeyCapabilitiesDto } from "@tornscope/shared";
import { me } from "./state.svelte";
import { featureAvailability, FEATURE_REQUIREMENTS, moduleAvailability } from "@tornscope/shared";

/**
 * Client-side mapping of permission states to the StateMessage variants.
 * The rule: permission problems NEVER render as zeros or "No data".
 */

export function availabilityMessage(
  av: FeatureAvailabilityDto,
  opts: { isDemo?: boolean } = {}
): { state: "permission" | "stale" | "empty"; title: string; hint: string } {
  // Demo presents synthetic data naturally: missing sections are just empty
  // demo sections, never permission/stale complaints about a key that does
  // not exist in demo mode.
  const isDemo = opts.isDemo ?? me.data?.isDemo === true;
  if (isDemo) {
    return av.state === 'unavailable_source' || av.state === 'unavailable_permission'
      ? {
          state: 'empty',
          title: 'No demo data in this range',
          hint: 'Synthetic example data — the demo dataset does not include this section.',
        }
      : {
          state: 'empty',
          title: 'Demo data',
          hint: 'Synthetic example data included with the demo dataset.',
        };
  }
  if (av.state === 'unavailable_permission') {
    return {
      state: "permission",
      title: "Unavailable with current API permissions",
      hint: av.requiresLabel
        ? `Your current API key does not provide ${av.requiresLabel}. Grant it in Torn (torn.com/preferences.php#tab=api) to unlock this data.`
        : "Your current API key does not provide the data source this section needs.",
    };
  }
  if (av.state === "stale_permission") {
    const refreshed = av.lastRefreshedAt ? new Date(av.lastRefreshedAt * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : null;
    return {
      state: "stale",
      title: "Historical data available — not refreshing",
      hint: `Previously collected data${refreshed ? ` (last refreshed ${refreshed})` : ""} is still available. Your current API key cannot refresh this dataset${av.requiresLabel ? ` — it lacks ${av.requiresLabel}` : ""}.`,
    };
  }
  return {
    state: "empty",
    title: "No data in this range yet",
    hint: "The source is connected and this dataset will appear as the sync collects it.",
  };
}

/** True when a section renders its data (any availability state with data). */
export function availabilityHasData(av: FeatureAvailabilityDto): boolean {
  return av.state === "available_live" || av.state === "available_historical" || av.state === "partial" || av.state === "stale_permission";
}

/** Modules the key can power — used for the post-connect summary. */
export function moduleSummaries(caps: KeyCapabilitiesDto | null) {
  return moduleAvailability(caps ?? {
    canReadUserBasic: false, canReadUserBars: false, canReadUserCooldowns: false, canReadUserEducation: false,
    canReadUserTravel: false, canReadUserMoney: false, canReadUserLogs: false, canReadUserAttacks: false,
    canReadUserNetworth: false, canReadUserEvents: false, canReadUserPersonalStats: false,
    canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
    canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
    canReadFactionBalance: false, canReadFactionLogs: false,
  });
}

/**
 * Client-side permission check for dashboard tiles: null when the feature can
 * render, otherwise the permission explanation. Treated as permission-blocked
 * only when the key actively lacks the requirement — no key / unknown
 * capabilities render normal empty states instead of accusations.
 */
export function clientPermissionMessage(caps: KeyCapabilitiesDto | null, feature: Parameters<typeof featureAvailability>[1]): { title: string; hint: string } | null {
  if (!caps) return null;
  const av = featureAvailability(caps, feature, { hasStoredData: false, lastSuccessAt: null });
  if (av.state !== "unavailable_permission") return null;
  return {
    title: "Unavailable with current API permissions",
    hint: av.requiresLabel
      ? `Your current API key does not provide ${av.requiresLabel} — this section needs it to collect data.`
      : "Your current API key does not provide the data source this section needs.",
  };
}

export { featureAvailability, FEATURE_REQUIREMENTS };
