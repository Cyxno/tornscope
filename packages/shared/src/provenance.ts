/**
 * Data provenance. Every calculated metric traces back to one of these levels:
 * - exact:     value provided verbatim by the Torn API
 * - derived:   computed from exact Torn data without estimation
 * - estimated: relies on an internal estimate (e.g. resale price)
 */
export const PROVENANCE = {
  exact: "exact",
  derived: "derived",
  estimated: "estimated",
} as const;

export type Provenance = keyof typeof PROVENANCE;

export interface WithProvenance {
  provenance: Provenance;
}

/** Attach provenance metadata to a value. */
export function mark<T extends object>(value: T, provenance: Provenance): T & WithProvenance {
  return Object.assign(value, { provenance });
}
