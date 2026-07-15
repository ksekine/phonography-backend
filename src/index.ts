import { Hono } from "hono";
import recordingsRoutes from "./routes/recordings";
import webhooksRoutes from "./routes/webhooks";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

// ヘルスチェック(独自ドメインの疎通確認にも使う)
app.get("/", (c) => {
  return c.text("Hello Hono!");
});

// 認証はルートごとに指定する(公開閲覧系は optionalAuth、それ以外は requireAuth)
app.route("/api", recordingsRoutes);

// Clerk Webhook (Svix 署名で検証するため /api/* の認証対象外)
app.route("/webhooks", webhooksRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
