import { Hono } from "hono";
import { deleteUserData } from "../lib/users";
import { requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types";

const app = new Hono<AppEnv>();

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
