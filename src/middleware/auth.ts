import { createClerkClient } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { users } from "../db/schema";
import type { AppEnv } from "../types";

/**
 * Clerk のセッション検証。認証処理のみを try/catch で包み、
 * 不正・破損トークンは(例外ではなく)未認証として扱う。
 */
async function verifyClerkUserId(c: Context<AppEnv>): Promise<string | null> {
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
  });
  try {
    const state = await clerk.authenticateRequest(c.req.raw);
    if (state.isAuthenticated) {
      return state.toAuth().userId;
    }
  } catch {
    // 形式不正なトークン等は decodeJwt が throw する → 未認証として扱う
  }
  return null;
}

/**
 * ログイン必須のエンドポイント用。
 * 検証成功時に users へ lazy upsert し、BAN されたユーザー(users.banned_at)は 403。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const userId = await verifyClerkUserId(c);
  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const db = drizzle(c.env.DB);
  const [, rows] = await db.batch([
    db
      .insert(users)
      .values({ id: userId, createdAt: new Date() })
      .onConflictDoNothing(),
    db.select({ bannedAt: users.bannedAt }).from(users).where(eq(users.id, userId)),
  ]);
  if (rows[0]?.bannedAt) {
    return c.json({ error: "forbidden" }, 403);
  }

  c.set("userId", userId);
  await next();
});

/**
 * 未ログインでも通すエンドポイント用(公開録音の閲覧系)。
 * ログイン済みなら userId を設定し、本人判定(private の閲覧・likedByMe)を有効にする。
 * 匿名時は userId = ""(どの録音の所有者とも一致しない)。DB へのアクセスはしない。
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  c.set("userId", (await verifyClerkUserId(c)) ?? "");
  await next();
});
