import { redirect } from "@sveltejs/kit";

/** Organized crime lives on the Faction page's "Organized Crime" tab — this
 *  legacy subroute duplicated it as an orphaned ComingSoon page. */
export function load(): never {
  redirect(308, "/faction");
}
