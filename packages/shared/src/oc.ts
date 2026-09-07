/**
 * Organized-crime participation states — semantic, never blank:
 * - participating:     the participant data positively includes the current
 *                      Torn ID;
 * - not_participating: the participant list is available and the current
 *                      Torn ID is absent;
 * - unavailable:       the current API permissions / source payload do not
 *                      permit determining participant membership.
 */
export type OcParticipationState = "participating" | "not_participating" | "unavailable";

export function ocParticipationState(oc: { myParticipation: boolean; participantsIdentifiable: boolean }): OcParticipationState {
  if (!oc.participantsIdentifiable) return "unavailable";
  return oc.myParticipation ? "participating" : "not_participating";
}

export const OC_PARTICIPATION_LABELS: Record<OcParticipationState, string> = {
  participating: "You are participating",
  not_participating: "Not participating",
  unavailable: "Participation unavailable",
};
