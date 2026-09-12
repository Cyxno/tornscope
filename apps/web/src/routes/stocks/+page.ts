import { redirect } from "@sveltejs/kit";

/** Stock analytics never shipped; stock value is reported in the Economy
 *  net-worth lens. This legacy v0.1 route forwards there. */
export function load(): never {
  redirect(308, "/money");
}
