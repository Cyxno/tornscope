import { getPrismaClient } from "@tornscope/database";
import { DEMO_USER_EMAIL } from "@tornscope/shared";

/**
 * Authentication seam.
 *
 * The MVP ships a single local owner account (self-hosted, no login). This
 * module is the ONLY place that resolves the current user, so real auth
 * (sessions, tokens, multi-user) can be added later without touching routes.
 *
 * Demo view: an explicit per-owner opt-in flag resolves requests to the
 * dedicated demo account. It works both before and after a real key is
 * connected — it is a deliberate view switch, and saving/replacing the API
 * key clears it automatically so the real account always wins. Demo data
 * stays in its own user row and is never mixed with a real player's data.
 */
const DEMO_VIEW_KEY = "demo_view";

export async function resolveCurrentUser() {
  const db = getPrismaClient();
  let user = await db.user.findFirst({
    where: { role: "owner", isDemo: false },
    orderBy: { createdAt: "asc" },
  });
  if (!user) {
    user = await db.user.create({
      data: { displayName: "Owner", role: "owner", isDemo: false },
    });
  }

  const flag = await db.appSetting.findUnique({
    where: { userId_key: { userId: user.id, key: DEMO_VIEW_KEY } },
  });
  if (flag) {
    const demo = await db.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
    if (demo) return demo;
  }

  return user;
}

export type CurrentUser = Awaited<ReturnType<typeof resolveCurrentUser>>;
