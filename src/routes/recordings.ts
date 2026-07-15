import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, lt, lte, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { likes, recordings, reports } from "../db/schema";
import { toMapRecording, toPublicRecording } from "../lib/dto";
import { encodeGeohash } from "../lib/geohash";
import { presignPutUrl } from "../lib/r2presign";
import {
  MAX_AUDIO_BYTES,
  MIME,
  REPORT_HIDE_THRESHOLD,
  UPLOAD_URL_EXPIRES_SECONDS,
  bumpCounter,
  canView,
  isLikedBy,
  loadRecording,
  refreshScore,
  sanitizeFilename,
  type RecordingRow,
} from "../lib/recordings";
import { computeScore } from "../lib/score";
import type { AppEnv } from "../types";
import {
  createRecordingSchema,
  mapQuerySchema,
  myListQuerySchema,
  reportSchema,
  searchQuerySchema,
  updateRecordingSchema,
} from "../validators/recordings";

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// upload (2 段階): POST /recordings → クライアントが R2 へ PUT → POST /recordings/:id/complete
// ---------------------------------------------------------------------------

app.post(
  "/recordings",
  requireAuth,
  zValidator("json", createRecordingSchema),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);
    const id = crypto.randomUUID();
    const ext = body.format === "wav" ? "wav" : "m4a";
    const audioKey = `audio/${id}.${ext}`;
    const now = new Date();

    await db.insert(recordings).values({
      id,
      userId: c.get("userId"),
      title: body.title ?? null,
      description: body.description ?? null,
      latitude: body.latitude,
      longitude: body.longitude,
      address: body.address ?? null,
      geohash: encodeGeohash(body.latitude, body.longitude),
      durationSeconds: body.durationSeconds,
      format: body.format,
      audioKey,
      recordedAt: body.recordedAt ? new Date(body.recordedAt * 1000) : null,
      createdAt: now,
      updatedAt: now,
    });

    const uploadUrl = await presignPutUrl(
      c.env,
      audioKey,
      UPLOAD_URL_EXPIRES_SECONDS
    );
    const imageUploadUrl = body.hasImage
      ? await presignPutUrl(
          c.env,
          `images/${id}.jpg`,
          UPLOAD_URL_EXPIRES_SECONDS
        )
      : undefined;

    return c.json(
      { id, uploadUrl, imageUploadUrl, expiresIn: UPLOAD_URL_EXPIRES_SECONDS },
      201
    );
  }
);

app.post("/recordings/:id/complete", requireAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || row.userId !== c.get("userId") || row.status === "deleted") {
    return c.json({ error: "not_found" }, 404);
  }
  if (row.status !== "pending") {
    // 冪等: 既に完了済みなら現状を返す
    return c.json(toPublicRecording(row, { isMine: true }));
  }

  const head = await c.env.BUCKET.head(row.audioKey);
  if (!head) {
    return c.json({ error: "audio_not_uploaded" }, 400);
  }
  if (head.size > MAX_AUDIO_BYTES) {
    await c.env.BUCKET.delete(row.audioKey);
    return c.json({ error: "file_too_large", maxBytes: MAX_AUDIO_BYTES }, 413);
  }

  const imageKey = `images/${row.id}.jpg`;
  const imageHead = await c.env.BUCKET.head(imageKey);

  const now = new Date();
  await db
    .update(recordings)
    .set({
      status: "ready",
      fileSizeBytes: head.size,
      imageKey: imageHead ? imageKey : null,
      score: computeScore(0, 0, 0, row.createdAt),
      updatedAt: now,
    })
    .where(eq(recordings.id, row.id));

  const updated = await loadRecording(db, row.id);
  return c.json(toPublicRecording(updated as RecordingRow, { isMine: true }));
});

// ---------------------------------------------------------------------------
// map (レコメンド: ビューポート内を score 順に返す)
// ※ /recordings/:id より先に定義してパスの衝突を避ける
// ---------------------------------------------------------------------------

app.get(
  "/recordings/map",
  optionalAuth,
  zValidator("query", mapQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const db = drizzle(c.env.DB);
    const rows = await db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.status, "ready"),
          eq(recordings.visibility, "public"),
          gte(recordings.latitude, q.minLat),
          lte(recordings.latitude, q.maxLat),
          gte(recordings.longitude, q.minLng),
          lte(recordings.longitude, q.maxLng)
        )
      )
      .orderBy(desc(recordings.score))
      .limit(q.limit);
    return c.json({ items: rows.map(toMapRecording) });
  }
);

// ---------------------------------------------------------------------------
// search (title / description / address の部分一致。公開録音のみ、score 順)
// ※ /recordings/:id より先に定義してパスの衝突を避ける
// ---------------------------------------------------------------------------

app.get(
  "/recordings/search",
  optionalAuth,
  zValidator("query", searchQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const db = drizzle(c.env.DB);
    // LIKE のワイルドカード(% _ \)をエスケープした部分一致パターン
    const pattern = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.status, "ready"),
          eq(recordings.visibility, "public"),
          or(
            sql`${recordings.title} LIKE ${pattern} ESCAPE '\\'`,
            sql`${recordings.description} LIKE ${pattern} ESCAPE '\\'`,
            sql`${recordings.address} LIKE ${pattern} ESCAPE '\\'`
          )
        )
      )
      .orderBy(desc(recordings.score))
      .limit(q.limit)
      .offset(q.offset);
    return c.json({ items: rows.map((r) => toPublicRecording(r)) });
  }
);

// ---------------------------------------------------------------------------
// own list
// ---------------------------------------------------------------------------

app.get(
  "/me/recordings",
  requireAuth,
  zValidator("query", myListQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const db = drizzle(c.env.DB);
    const conditions = [
      eq(recordings.userId, c.get("userId")),
      ne(recordings.status, "deleted"),
    ];
    if (q.cursor) {
      conditions.push(lt(recordings.createdAt, new Date(q.cursor * 1000)));
    }
    const rows = await db
      .select()
      .from(recordings)
      .where(and(...conditions))
      .orderBy(desc(recordings.createdAt))
      .limit(q.limit);
    const last = rows.at(-1);
    return c.json({
      items: rows.map((r) => toPublicRecording(r, { isMine: true })),
      nextCursor:
        rows.length === q.limit && last
          ? Math.floor(last.createdAt.getTime() / 1000)
          : null,
    });
  }
);

// ---------------------------------------------------------------------------
// detail / update / delete
// ---------------------------------------------------------------------------

app.get("/recordings/:id", optionalAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("userId");
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, userId)) {
    return c.json({ error: "not_found" }, 404);
  }
  const likedByMe = userId ? await isLikedBy(db, userId, row.id) : undefined;
  return c.json(
    toPublicRecording(row, { isMine: row.userId === userId, likedByMe })
  );
});

app.patch(
  "/recordings/:id",
  requireAuth,
  zValidator("json", updateRecordingSchema),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);
    const row = await loadRecording(db, c.req.param("id"));
    if (!row || row.userId !== c.get("userId") || row.status === "deleted") {
      return c.json({ error: "not_found" }, 404);
    }

    const set: Partial<typeof recordings.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.title !== undefined) set.title = body.title;
    if (body.description !== undefined) set.description = body.description;
    if (body.address !== undefined) set.address = body.address;
    if (body.visibility !== undefined) set.visibility = body.visibility;
    if (body.recordedAt !== undefined) {
      set.recordedAt = body.recordedAt
        ? new Date(body.recordedAt * 1000)
        : null;
    }
    if (body.latitude !== undefined && body.longitude !== undefined) {
      set.latitude = body.latitude;
      set.longitude = body.longitude;
      set.geohash = encodeGeohash(body.latitude, body.longitude);
    }
    await db.update(recordings).set(set).where(eq(recordings.id, row.id));

    const updated = await loadRecording(db, row.id);
    return c.json(toPublicRecording(updated as RecordingRow, { isMine: true }));
  }
);

app.delete("/recordings/:id", requireAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || row.userId !== c.get("userId") || row.status === "deleted") {
    return c.json({ error: "not_found" }, 404);
  }
  // ソフトデリート。R2 実体の削除はレスポンスを待たせず行う
  await db
    .update(recordings)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(recordings.id, row.id));
  c.executionCtx.waitUntil(
    Promise.all([
      c.env.BUCKET.delete(row.audioKey),
      row.imageKey ? c.env.BUCKET.delete(row.imageKey) : Promise.resolve(),
    ])
  );
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// media: image / streaming / download
// ---------------------------------------------------------------------------

app.get("/recordings/:id/image", optionalAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, c.get("userId")) || !row.imageKey) {
    return c.json({ error: "not_found" }, 404);
  }
  const object = await c.env.BUCKET.get(row.imageKey);
  if (!object) {
    return c.json({ error: "not_found" }, 404);
  }
  return new Response(object.body, {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(object.size),
      etag: object.httpEtag,
      "cache-control": "private, max-age=86400",
    },
  });
});

/**
 * ストリーミング再生。HTTP Range リクエストに 206 で応答する。
 * R2 の body をそのまま流すだけなので CPU 時間はほぼ消費しない。
 */
app.get("/recordings/:id/stream", optionalAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, c.get("userId")) || row.status === "pending") {
    return c.json({ error: "not_found" }, 404);
  }

  const rangeHeader = c.req.header("range");
  const object = await c.env.BUCKET.get(row.audioKey, {
    range: c.req.raw.headers, // Range ヘッダーを R2 が解釈する
    onlyIf: c.req.raw.headers, // If-None-Match 等の条件付きリクエスト
  });
  if (!object) {
    return c.json({ error: "not_found" }, 404);
  }

  const headers = new Headers({
    "content-type": MIME[row.format],
    etag: object.httpEtag,
    "accept-ranges": "bytes",
  });

  // onlyIf 条件を満たさない場合、body なしの R2Object が返る → 304
  if (!("body" in object) || !object.body) {
    return new Response(null, { status: 304, headers });
  }

  let status = 200;
  if (rangeHeader && object.range) {
    const r = object.range as {
      offset?: number;
      length?: number;
      suffix?: number;
    };
    const offset =
      r.suffix !== undefined ? object.size - r.suffix : r.offset ?? 0;
    const length =
      r.suffix !== undefined ? r.suffix : r.length ?? object.size - offset;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`
    );
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(object.size));
  }

  // 再生カウント: 冒頭からの取得のみ数える(シークで生じる途中 Range は数えない)
  if (!rangeHeader || /^bytes=0-/.test(rangeHeader)) {
    c.executionCtx.waitUntil(bumpCounter(db, row.id, "playCount"));
  }

  return new Response(object.body, { status, headers });
});

app.get("/recordings/:id/download", optionalAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, c.get("userId")) || row.status === "pending") {
    return c.json({ error: "not_found" }, 404);
  }

  const object = await c.env.BUCKET.get(row.audioKey);
  if (!object) {
    return c.json({ error: "not_found" }, 404);
  }

  const ext = row.format === "wav" ? "wav" : "m4a";
  const base = sanitizeFilename(row.title ?? "") || row.id;
  const filename = `${base}.${ext}`;

  c.executionCtx.waitUntil(bumpCounter(db, row.id, "downloadCount"));

  return new Response(object.body, {
    headers: {
      "content-type": MIME[row.format],
      "content-length": String(object.size),
      etag: object.httpEtag,
      // 日本語等の非 ASCII タイトルは RFC 5987 の filename* で渡す
      "content-disposition": `attachment; filename="${
        row.id
      }.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
});

// ---------------------------------------------------------------------------
// like / unlike
// ---------------------------------------------------------------------------

app.post("/recordings/:id/like", requireAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("userId");
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, userId) || row.status === "pending") {
    return c.json({ error: "not_found" }, 404);
  }

  // いいね本体と like_count の再集計を同一 batch で行い整合を保つ
  await db.batch([
    db
      .insert(likes)
      .values({ userId, recordingId: row.id, createdAt: new Date() })
      .onConflictDoNothing(),
    db
      .update(recordings)
      .set({
        likeCount: sql`(SELECT COUNT(*) FROM likes WHERE recording_id = ${row.id})`,
      })
      .where(eq(recordings.id, row.id)),
  ]);
  await refreshScore(db, row.id);

  const updated = await loadRecording(db, row.id);
  return c.json({
    liked: true,
    likeCount: updated?.likeCount ?? row.likeCount + 1,
  });
});

app.delete("/recordings/:id/like", requireAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("userId");
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, userId)) {
    return c.json({ error: "not_found" }, 404);
  }

  await db.batch([
    db
      .delete(likes)
      .where(and(eq(likes.userId, userId), eq(likes.recordingId, row.id))),
    db
      .update(recordings)
      .set({
        likeCount: sql`(SELECT COUNT(*) FROM likes WHERE recording_id = ${row.id})`,
      })
      .where(eq(recordings.id, row.id)),
  ]);
  await refreshScore(db, row.id);

  const updated = await loadRecording(db, row.id);
  return c.json({
    liked: false,
    likeCount: updated?.likeCount ?? Math.max(0, row.likeCount - 1),
  });
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

app.post(
  "/recordings/:id/report",
  requireAuth,
  zValidator("json", reportSchema),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);
    const userId = c.get("userId");
    const row = await loadRecording(db, c.req.param("id"));
    if (!row || !canView(row, userId)) {
      return c.json({ error: "not_found" }, 404);
    }

    const inserted = await db
      .insert(reports)
      .values({
        id: crypto.randomUUID(),
        recordingId: row.id,
        reporterUserId: userId,
        reason: body.reason,
        detail: body.detail ?? null,
        createdAt: new Date(),
      })
      .onConflictDoNothing() // 同一ユーザーの重複通報は無視(冪等)
      .returning({ id: reports.id });

    if (inserted.length > 0) {
      // report_count を再集計し、閾値を超えた ready の録音は自動で非表示にする
      await db
        .update(recordings)
        .set({
          reportCount: sql`(SELECT COUNT(*) FROM reports WHERE recording_id = ${row.id})`,
          status: sql`CASE WHEN (SELECT COUNT(*) FROM reports WHERE recording_id = ${row.id}) >= ${REPORT_HIDE_THRESHOLD} AND status = 'ready' THEN 'hidden' ELSE status END`,
          updatedAt: new Date(),
        })
        .where(eq(recordings.id, row.id));
    }

    return c.json({ reported: true }, inserted.length > 0 ? 201 : 200);
  }
);

export default app;
