import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Firebase Authentication ユーザーの最小ミラー。
 * プロフィール情報は Firebase 側が持つため複製しない(匿名公開のため表示にも使わない)。
 * 行は認証済みリクエストの初回に lazy upsert する。
 * 匿名認証ユーザーも同じ扱い(正規アカウントへの昇格時も UID は変わらない)。
 */
export const users = sqliteTable("users", {
  // Firebase の UID をそのまま使う
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  // 運営によるアカウント停止。ブロック機能を持たない代わりのモデレーション手段
  bannedAt: integer("banned_at", { mode: "timestamp" }),
});

/**
 * 録音(中核テーブル)。音声・画像の実体は R2 に置き、DB はキーのみ持つ。
 *
 * 匿名公開: 録音には位置情報が紐づくため、user_id は権限判定・モデレーション
 * 専用の内部カラムとし、公開 API のレスポンスには一切含めないこと。
 *
 * status はシステム側のライフサイクル:
 *   pending(メタデータ登録・署名付き PUT URL 発行済み)
 *   → ready(クライアントの R2 アップロード完了を確認して公開)
 *   → hidden(通報閾値超過・運営判断で非表示) / deleted(ソフトデリート)
 * visibility はユーザー操作のフラグで status とは独立(公開後に非公開へ戻せる)。
 * 一覧・マップに出すのは常に status = 'ready' AND visibility = 'public'。
 *
 * *_count は非正規化カウンタ。likes/reports 等の書き込みと同一の
 * D1 batch で増減させ、整合を保つ。
 */
export const recordings = sqliteTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title"),
    description: text("description"),
    // 位置情報なしでも公開できる。その場合は検索対象だがマップ対象外。
    latitude: real("latitude"),
    longitude: real("longitude"),
    // クライアントが逆ジオコーディング済みの表示用文字列
    address: text("address"),
    // 緯度経度から精度7で導出。ビューポート検索・クラスタリング補助用
    geohash: text("geohash"),
    durationSeconds: real("duration_seconds").notNull(),
    format: text("format", { enum: ["wav", "m4a"] }).notNull(),
    // ラウドネス正規化用メタデータ(クライアント測定・非破壊方式)。
    // 再生側が「ターゲット(-16 LUFS) − loudness_lufs」の静的ゲインを計算し、
    // true_peak_db でクリッピングガード、ブースト方向は非対称にキャップする。
    // ファイル自体は原音のまま(ダウンロードは無加工)
    loudnessLufs: real("loudness_lufs"),
    truePeakDb: real("true_peak_db"),
    // アップロード完了確認時に R2 の HEAD で検証して記録(pending の間は 0)
    fileSizeBytes: integer("file_size_bytes").notNull().default(0),
    // R2 キー: audio/{id}.{ext}
    audioKey: text("audio_key").notNull().unique(),
    // R2 キー: images/{id}.jpg (カバー写真)
    imageKey: text("image_key"),
    status: text("status", { enum: ["pending", "ready", "hidden", "deleted"] })
      .notNull()
      .default("pending"),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    likeCount: integer("like_count").notNull().default(0),
    playCount: integer("play_count").notNull().default(0),
    downloadCount: integer("download_count").notNull().default(0),
    reportCount: integer("report_count").notNull().default(0),
    // レコメンド用の事前計算スコア(人気 ÷ 時間減衰、src/lib/score.ts が実装):
    //   (1 + like_count * 3 + play_count + download_count * 2)
    //     / pow((now - created_at) / 86400 + 2, 1.5)
    // いいね/再生/DL イベント時に該当行のみ再計算し、
    // 時間減衰の反映は Workers Cron で全件再計算する(triggers は後日追加)
    score: real("score").notNull().default(0),
    recordedAt: integer("recorded_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // 公開クエリ(ready かつ public)専用の部分インデックス
    index("recordings_public_location_idx")
      .on(t.latitude, t.longitude)
      .where(sql`status = 'ready' AND visibility = 'public'`),
    index("recordings_public_score_idx")
      .on(t.score)
      .where(sql`status = 'ready' AND visibility = 'public'`),
    index("recordings_geohash_idx").on(t.geohash),
    // 自分の録音一覧(private も含めて返す)
    index("recordings_user_created_idx").on(t.userId, t.createdAt),
  ]
);

/**
 * A staged replacement for a recording. Objects use generation-specific keys
 * so a failed upload never overwrites the currently active media.
 */
export const recordingUploadSessions = sqliteTable(
  "recording_upload_sessions",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id),
    audioKey: text("audio_key").notNull().unique(),
    imageKey: text("image_key"),
    title: text("title"),
    description: text("description"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    address: text("address"),
    geohash: text("geohash"),
    durationSeconds: real("duration_seconds").notNull(),
    format: text("format", { enum: ["wav", "m4a"] }).notNull(),
    loudnessLufs: real("loudness_lufs"),
    truePeakDb: real("true_peak_db"),
    recordedAt: integer("recorded_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("recording_upload_sessions_recording_idx").on(t.recordingId)]
);

/**
 * いいね。「自分がいいねしたか」は本人にのみ返し、
 * 他人のいいね一覧は公開しない(匿名性の一部)。
 */
export const likes = sqliteTable(
  "likes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.recordingId] }),
    index("likes_recording_idx").on(t.recordingId),
  ]
);

/**
 * 通報。作成時に recordings.report_count を同一 batch でインクリメントし、
 * 閾値(例: 3)を超えたら recordings.status を 'hidden' にするのはアプリロジック側の責務。
 */
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason", {
      enum: ["inappropriate", "privacy", "copyright", "spam", "other"],
    }).notNull(),
    detail: text("detail"),
    status: text("status", { enum: ["pending", "dismissed", "actioned"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
  },
  (t) => [
    // 同一ユーザーによる同一録音への重複通報を防ぐ
    uniqueIndex("reports_recording_reporter_uq").on(
      t.recordingId,
      t.reporterUserId
    ),
  ]
);
