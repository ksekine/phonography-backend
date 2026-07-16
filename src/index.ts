import { Hono } from "hono";
import meRoutes from "./routes/me";
import recordingsRoutes from "./routes/recordings";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

// ヘルスチェック(独自ドメインの疎通確認にも使う)
app.get("/", (c) => {
  return c.text("Hello Hono!");
});

// 認証はルートごとに指定する(公開閲覧系は optionalAuth、それ以外は requireAuth)
app.route("/api", recordingsRoutes);
app.route("/api/me", meRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
