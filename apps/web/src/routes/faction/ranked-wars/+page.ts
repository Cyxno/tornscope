import { redirect } from "@sveltejs/kit";

/** Ranked wars live on the Faction page's "Ranked Wars" tab — this legacy
 *  subroute duplicated it as an orphaned ComingSoon page. */
export function load(): never {
  redirect(308, "/faction");
}
