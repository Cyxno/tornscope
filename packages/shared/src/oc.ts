/**
 * Organized-crime participation states — semantic, never blank, and derived
 * from PARTICIPANT DATA (never from slot counts):
 *
 * - participating:      the OC's participant data positively includes the
 *                       current Torn ID;
 * - assigned_elsewhere: the user is positively participating in ANOTHER
 *                       active OC. Torn allows one OC assignment at a time
 *                       (leaving is required before joining another), so
 *                       this is contextual rather than a plain "no";
 * - not_participating:  the participant list is visible and the current
 *                       Torn ID is absent, and the user is not in any other
 *                       known OC;
 * - unavailable:        TornScope genuinely lacks the participant/member
 *                       data to answer (no slot payload, permission or
 *                       identity missing) — NEVER because slots are open.
 *
 * Slot availability (filled / open / full) is reported separately and must
 * never be used to infer participation.
 */
export type OcParticipationState = "participating" | "assigned_elsewhere" | "not_participating" | "unavailable";

export function ocParticipationState(
  oc: { myParticipation: boolean; participantsIdentifiable: boolean },
  context: { userInAnyKnownOc: boolean } = { userInAnyKnownOc: false }
): OcParticipationState {
  if (!oc.participantsIdentifiable) return "unavailable";
  if (oc.myParticipation) return "participating";
  if (context.userInAnyKnownOc) return "assigned_elsewhere";
  return "not_participating";
}

export const OC_PARTICIPATION_LABELS: Record<OcParticipationState, string> = {
  participating: "You are participating",
  assigned_elsewhere: "Already assigned to another OC",
  not_participating: "Not participating",
  unavailable: "Participation unavailable",
};

/** Explanation shown for the contextual states (honest about the game rule). */
export const OC_PARTICIPATION_HINTS: Record<OcParticipationState, string | null> = {
  participating: null,
  assigned_elsewhere: "Torn allows one OC assignment at a time — leave your current OC before joining another.",
  not_participating: null,
  unavailable: "The current API payload does not carry this OC's participant list, so membership cannot be determined.",
};

/**
 * Primary context (Phase: determine MY current OC first): the user is
 * positively participating in at least one ACTIVE stored OC.
 */
export function userInAnyKnownOc(activeOcs: Array<{ myParticipation: boolean; participantsIdentifiable: boolean }>): boolean {
  return activeOcs.some((oc) => oc.participantsIdentifiable && oc.myParticipation);
}
