/**
 * Faction armory news parser (/v2/faction/news?cat=armoryAction).
 *
 * Observed entry shapes (HTML-stripped):
 *   "Luhhxa used one of the faction's Morphine items"
 *   "Cyxno used 28 of the faction's Xanax items"
 *   "4lucard filled one of the faction's Empty Blood Bags to create a Blood Bag : A+"
 *   "xo- loaned 50x Tear Gas to themselves from the faction armory"
 *   "Draythynn returned 14x Smoke Grenade"
 *   "Hundog gave 1x Pillow to Mathiaas from the faction armory"
 *
 * Only entries that fully parse produce events — never guessed members or
 * items. "used"/"filled" are consumption-shaped actions (the member consumed
 * faction stock); loaned/gave/returned are movement-shaped.
 */

export interface ParsedArmoryNews {
  memberId: number | null;
  memberName: string | null;
  action: "used" | "loaned" | "gave" | "returned" | "deposited" | "filled";
  itemName: string;
  quantity: number;
}

const stripTags = (s: string): string => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1 };

function parseQuantity(raw: string): number {
  const t = raw.trim().toLowerCase();
  if (WORD_NUMBERS[t] !== undefined) return WORD_NUMBERS[t]!;
  return parseInt(t.replace(/,/g, ""), 10) || 1;
}

/** Extract the acting member's Torn id + name from the leading profile link. */
function parseMember(text: string): { memberId: number | null; memberName: string | null } {
  const m = /XID=(\d+)[^>]*>([^<]+)<\/a>/i.exec(text);
  if (!m) return { memberId: null, memberName: stripTags(text).split(" ")[0] ?? null };
  return { memberId: parseInt(m[1]!, 10), memberName: m[2]!.trim() };
}

/**
 * Parse one armory news entry. Returns null for entries that do not describe
 * a member action on an armory item (never fabricates).
 */
export function parseArmoryNews(html: string): ParsedArmoryNews | null {
  const text = stripTags(html);
  const member = parseMember(html);
  const trailing = /\s+(?:from the faction armory|from the armory)?\.?$/i;

  // "used one of the faction's Xanax items" / "used 28 of the faction's X items"
  const used = / used (one|[\d,]+) of the faction's (.+?) items?$/i.exec(text);
  if (used) {
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      action: "used",
      itemName: used[2]!.trim(),
      quantity: parseQuantity(used[1]!),
    };
  }

  // "filled one of the faction's Empty Blood Bags to create a Blood Bag : A+"
  const filled = / filled (one|[\d,]+) of the faction's (.+?) to create /i.exec(text);
  if (filled) {
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      action: "filled",
      itemName: filled[2]!.trim(),
      quantity: parseQuantity(filled[1]!),
    };
  }

  // "loaned 50x Tear Gas to themselves from the faction armory"
  const loaned = / loaned ([\d,]+)x (.+?) to (themselves|[^ ]+) from the faction armory/i.exec(text);
  if (loaned) {
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      action: "loaned",
      itemName: loaned[2]!.trim().replace(trailing, "").trim(),
      quantity: parseQuantity(loaned[1]!),
    };
  }

  // "gave 1x Pillow to Mathiaas from the faction armory"
  const gave = / gave ([\d,]+)x (.+?) to [^ ]+ from the faction armory/i.exec(text);
  if (gave) {
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      action: "gave",
      itemName: gave[2]!.trim().replace(trailing, "").trim(),
      quantity: parseQuantity(gave[1]!),
    };
  }

  // "returned 14x Smoke Grenade" (returned TO the armory)
  const returned = / returned ([\d,]+)x (.+)$/i.exec(text);
  if (returned) {
    return {
      memberId: member.memberId,
      memberName: member.memberName,
      action: "returned",
      itemName: returned[2]!.trim().replace(trailing, "").trim(),
      quantity: parseQuantity(returned[1]!),
    };
  }

  return null;
}
