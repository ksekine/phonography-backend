import { verifyWebhook } from "@clerk/backend/webhooks";
import { Hono } from "hono";
import { deleteUserData } from "../lib/users";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

/**
 * Clerk Webhook (Svix 署名検証付き)。/api/* の認証とは独立したエンドポイント。
 * user.deleted: 退会ユーザーに紐づくデータ(録音・R2 実体・いいね・通報)を完全削除する。
 * 処理全体が冪等なので、失敗時は非 2xx を返して Svix のリトライに任せる。
 */
app.post("/clerk", async (c) => {
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(c.req.raw, {
      signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    return c.json({ error: "invalid_signature" }, 400);
  }

  if (event.type === "user.deleted" && event.data.id) {
    await deleteUserData(c.env, event.data.id);
  }
  // 対象外のイベントも 2xx を返す(返さないと Svix がリトライし続ける)
  return c.json({ received: true });
});

export default app;
