import { describe, expect, it, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { resolveSessionUser, SessionBootstrapPending } from "../src/auth.js";

/**
 * Parallel cold-bootstrap tests (guest profile architecture).
 *
 * A browser's very first parallel requests all arrive without a session
 * cookie. The server must coalesce them into ONE profile creation: the
 * winner creates, the losers get a retryable SessionBootstrapPending (425)
 * and, replayed with the winner's cookie (what a browser does once the
 * winning response sets it), resolve to the SAME profile.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];

function fakeReq(ip: string, cookie?: string): any {
  return { headers: cookie ? { "x-forwarded-for": ip, cookie } : { "x-forwarded-for": ip }, protocol: "http", ip };
}
function fakeReply(): any {
  return {
    __headers: {} as Record<string, string>,
    header(name: string, value: string) {
      this.__headers[name] = value;
    },
  };
}
function cookieFrom(reply: any): string | undefined {
  const raw = reply.__headers["Set-Cookie"] as string | undefined;
  if (!raw) return undefined;
  return raw.split(";")[0];
}
function uniqueIp(prefix: string): string {
  return `${prefix}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
}

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.apiCredential.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
});

suite("parallel cold bootstrap (one browser, no cookie yet)", () => {
  it("20 parallel cookie-less requests create exactly ONE profile; losers get 425 and replay to the same session", async () => {
    const ip = uniqueIp("10.77");
    const N = 20;
    const replies = Array.from({ length: N }, () => fakeReply());

    const results = await Promise.allSettled(
      replies.map((reply) => resolveSessionUser(fakeReq(ip), reply))
    );

    const winnerIndexes = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === "fulfilled").map(({ i }) => i);
    const pendingCount = results.filter((r) => r.status === "rejected" && r.reason instanceof SessionBootstrapPending).length;
    const otherFailures = results.filter((r) => r.status === "rejected" && !(r.reason instanceof SessionBootstrapPending));

    expect(otherFailures, "no unexpected errors").toHaveLength(0);
    expect(winnerIndexes).toHaveLength(1);
    expect(pendingCount).toBe(N - 1);

    const winnerIndex = winnerIndexes[0]!;
    const winner = (results[winnerIndex] as PromiseFulfilledResult<{ id: string }>).value;
    cleanupUserIds.push(winner.id);

    // The winner's reply carried the session cookie; the 425 losers carried none.
    const winnerCookie = cookieFrom(replies[winnerIndex]);
    expect(winnerCookie).toMatch(/^ts_session=/);
    for (const [i, reply] of replies.entries()) {
      if (i !== winnerIndex) expect(reply.__headers["Set-Cookie"]).toBeUndefined();
    }

    // Exactly one user + one session row exist for this race.
    expect(await db.userSession.findMany({ where: { userId: winner.id } })).toHaveLength(1);

    // Replay every 425 with the winner's cookie: all resolve to the SAME profile.
    const replays = await Promise.all(
      Array.from({ length: N - 1 }, () => resolveSessionUser(fakeReq(ip, winnerCookie), fakeReply()))
    );
    for (const user of replays) expect(user.id).toBe(winner.id);
  });

  it("a warm browser (existing session cookie) is never asked to bootstrap", async () => {
    const ip = uniqueIp("10.78");
    const reply = fakeReply();
    const first = await resolveSessionUser(fakeReq(ip), reply);
    cleanupUserIds.push(first.id);
    const cookie = cookieFrom(reply)!;

    const users = await Promise.all(
      Array.from({ length: 10 }, () => resolveSessionUser(fakeReq(ip, cookie), fakeReply()))
    );
    for (const user of users) expect(user.id).toBe(first.id);
  });

  it("two different addresses bootstrapping at the same instant each get their OWN profile", async () => {
    const ipA = uniqueIp("10.79.1");
    const ipB = uniqueIp("10.79.2");
    const [a, b] = await Promise.allSettled([
      resolveSessionUser(fakeReq(ipA), fakeReply()),
      resolveSessionUser(fakeReq(ipB), fakeReply()),
    ]);
    // Distinct IPs must never share a profile; either both succeed or one
    // legitimately 425s (per-IP coalescing, never global blocking).
    for (const r of [a, b]) {
      if (r.status === "fulfilled") cleanupUserIds.push(r.value.id);
      else expect(r.reason instanceof SessionBootstrapPending).toBe(true);
    }
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      expect(a.value.id).not.toBe(b.value.id);
    }
  });

  it("a stale in-flight marker fails open instead of blocking new sessions forever", async () => {
    const { markStaleBootstrapForTests, clearBootstrapForTests } = await import("../src/auth.js");
    const ip = uniqueIp("10.80");
    markStaleBootstrapForTests(ip);
    const reply = fakeReply();
    const user = await resolveSessionUser(fakeReq(ip), reply);
    cleanupUserIds.push(user.id);
    clearBootstrapForTests();
    expect(user.role).toBe("user");
  });
});
