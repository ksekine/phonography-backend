import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { users } from "../db/schema";
import type { AppEnv } from "../types";

// Firebase ID トークンの署名鍵 (Google の公開 JWKS)。
// createRemoteJWKSet が Cache-Control に従ってモジュールスコープでキャッシュする
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Firebase Authentication の ID トークン検証(匿名認証ユーザーも同じ形式)。
 * 公開鍵検証のためサーバー側シークレットは不要。
 * 不正・破損・期限切れトークンは(例外ではなく)未認証として扱う。
 */
async function verifyFirebaseUserId(c: Context<AppEnv>): Promise<string | null> {
  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  jwks ??= createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${c.env.FIREBASE_PROJECT_ID}`,
      audience: c.env.FIREBASE_PROJECT_ID,
      algorithms: ["RS256"],
    });
    // sub = Firebase UID(exp / iat / iss / aud / 署名は jwtVerify が検証済み)
    return typeof payload.sub === "string" && payload.sub.length > 0
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/**
 * ログイン必須のエンドポイント用。
 * 検証成功時に users へ lazy upsert し、BAN されたユーザー(users.banned_at)は 403。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const userId = await verifyFirebaseUserId(c);
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
 * ログイン済みなら userId を設定し、本人判定(private の閲覧など)を有効にする。
 * 匿名時は userId = ""(どの録音の所有者とも一致しない)。DB へのアクセスはしない。
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  c.set("userId", (await verifyFirebaseUserId(c)) ?? "");
  await next();
});
