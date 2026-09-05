import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, cursorWhere, nextPageCursor } from "../src/cursor.js";

describe("cursor pagination", () => {
  it("round-trips a cursor", () => {
    const cursor = encodeCursor({ occurredAt: 1_700_000_000, id: "abc123" });
    const info = decodeCursor(cursor);
    expect(info).toEqual({ occurredAt: 1_700_000_000, id: "abc123" });
  });

  it("rejects malformed cursors", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("nocolon", "utf8").toString("base64url"))).toBeNull();
  });

  it("cursorWhere builds keyset continuation conditions", () => {
    const cursor = encodeCursor({ occurredAt: 1_700_000_000, id: "row-9" });
    const where = cursorWhere(cursor) as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ occurredAt: { lt: new Date(1_700_000_000 * 1000) } });
    expect(where.OR[1]).toEqual({ occurredAt: new Date(1_700_000_000 * 1000), id: { lt: "row-9" } });
  });

  it("cursorWhere is undefined without a cursor", () => {
    expect(cursorWhere(undefined)).toBeUndefined();
  });

  it("nextPageCursor returns null for short pages", () => {
    const rows = [
      { occurredAt: new Date(1_700_000_000 * 1000), id: "a" },
      { occurredAt: new Date(1_699_999_000 * 1000), id: "b" },
    ];
    expect(nextPageCursor(rows, 3)).toBeNull();
    expect(nextPageCursor(rows, 2)).not.toBeNull();
  });
});
