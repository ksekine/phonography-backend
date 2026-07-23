import { zValidator } from "@hono/zod-validator";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { pushDevices } from "../db/schema";
import { deleteUserData } from "../lib/users";
import { requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types";
import {
  pushDeviceParamsSchema,
  upsertPushDeviceSchema,
} from "../validators/pushDevices";

const app = new Hono<AppEnv>();

app.put(
  "/push-devices/:installationId",
  requireAuth,
  zValidator("param", pushDeviceParamsSchema),
  zValidator("json", upsertPushDeviceSchema),
  async (c) => {
    const { installationId } = c.req.valid("param");
    const { fcmToken } = c.req.valid("json");
    const userId = c.get("userId");
    const now = new Date();
    const db = drizzle(c.env.DB);

    await db.batch([
      // FCM can move a token to a new app installation after restore/reinstall.
      db.delete(pushDevices).where(and(
        eq(pushDevices.fcmToken, fcmToken),
        ne(pushDevices.installationId, installationId)
      )),
      db.insert(pushDevices).values({
        installationId,
        userId,
        fcmToken,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: pushDevices.installationId,
        set: { userId, fcmToken, updatedAt: now },
      }),
    ]);
    return c.body(null, 204);
  }
);

app.delete(
  "/push-devices/:installationId",
  requireAuth,
  zValidator("param", pushDeviceParamsSchema),
  async (c) => {
    const { installationId } = c.req.valid("param");
    await drizzle(c.env.DB).delete(pushDevices).where(and(
      eq(pushDevices.installationId, installationId),
      eq(pushDevices.userId, c.get("userId"))
    ));
    return c.body(null, 204);
  }
);

/**
 * 退会(アカウント削除)。紐づくデータ(録音・R2 実体・いいね・通報)を完全削除する。
 * Firebase Auth にはユーザー削除の Webhook がないため、クライアントが
 * 「この API を呼ぶ → 成功後に Firebase の user.delete()」の順で退会を実行する。
 * 冪等なので、途中失敗時はクライアントがリトライすればよい。
 */
app.delete("/", requireAuth, async (c) => {
  await deleteUserData(c.env, c.get("userId"));
  return c.body(null, 204);
});

export default app;
