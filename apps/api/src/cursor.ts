/**
 * Keyset (cursor) pagination for event tables, ordered by
 * occurredAt DESC, id DESC. Cursor format: base64url("occurredAt:id").
 */

export interface CursorInfo {
  occurredAt: number;
  id: string;
}

export function encodeCursor(info: CursorInfo): string {
  return Buffer.from(`${info.occurredAt}:${info.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorInfo | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf(":");
    if (idx <= 0) return null;
    const occurredAt = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(occurredAt) || !id) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

/** Build the Prisma `where` fragment that continues after a cursor. */
export function cursorWhere(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  const info = decodeCursor(cursor);
  if (!info) return undefined;
  const occurredAt = new Date(info.occurredAt * 1000);
  return {
    OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: info.id } }],
  };
}

export function nextPageCursor<T extends { occurredAt: Date; id: string }>(items: T[], limit: number): string | null {
  if (items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({ occurredAt: Math.floor(last.occurredAt.getTime() / 1000), id: last.id });
}
