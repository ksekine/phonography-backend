import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, gte, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type Context } from "hono";
import { optionalAuth, requireAuth } from "../middleware/auth";
import {
  likeNotificationReceipts,
  likes,
  recordingUploadSessions,
  recordings,
  reports,
} from "../db/schema";
import { toMapRecording, toPublicRecording } from "../lib/dto";
import { encodeGeohash } from "../lib/geohash";
import { presignPutUrl } from "../lib/r2presign";
import {
  DETAIL_CACHE_TTL_SECONDS,
  MAP_CACHE_TTL_SECONDS,
  MAP_CELL_PRECISION,
  MAX_AUDIO_BYTES,
  MIME,
  REPORT_HIDE_THRESHOLD,
  UPLOAD_URL_EXPIRES_SECONDS,
  bumpCounter,
  canView,
  isLikedBy,
  isReportedBy,
  loadRecording,
  refreshScore,
  type RecordingRow,
} from "../lib/recordings";
import { computeScore } from "../lib/score";
import { sendLikeNotification } from "../lib/fcm";
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

function publicDetailCacheKey(c: Context<AppEnv>, recordingId: string): Request {
  const url = new URL(c.req.url);
  const recordingsPathIndex = url.pathname.indexOf("/recordings/");
  url.pathname = `${url.pathname.slice(0, recordingsPathIndex)}/recordings/${recordingId}`;
  url.search = "";
  return new Request(url);
}

function invalidatePublicDetailCache(
  c: Context<AppEnv>,
  recordingId: string
): void {
  c.executionCtx.waitUntil(
    caches.default.delete(publicDetailCacheKey(c, recordingId))
  );
}

// ---------------------------------------------------------------------------
// upload (2 段階): POST /recordings → R2 PUT → upload session complete
// ---------------------------------------------------------------------------

app.post(
  "/recordings",
  requireAuth,
  zValidator("json", createRecordingSchema),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);
    const id = body.id;
    const uploadSessionId = crypto.randomUUID();
    const ext = body.format === "wav" ? "wav" : "m4a";
    const audioKey = `uploads/${id}/${uploadSessionId}/audio.${ext}`;
    const imageKey = body.hasImage
      ? `uploads/${id}/${uploadSessionId}/image.jpg`
      : null;
    const now = new Date();
    const userId = c.get("userId");
    const existing = await loadRecording(db, id);
    if (existing && existing.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    if (existing?.status === "deleted") {
      return c.json({ error: "recording_deleted" }, 409);
    }
    if (existing?.status === "hidden") {
      return c.json({ error: "recording_hidden" }, 409);
    }

    const previousSessions = await db
      .select()
      .from(recordingUploadSessions)
      .where(eq(recordingUploadSessions.recordingId, id));
    if (previousSessions.length > 0) {
      await db
        .delete(recordingUploadSessions)
        .where(eq(recordingUploadSessions.recordingId, id));
      c.executionCtx.waitUntil(
        Promise.all(
          previousSessions.flatMap((session) =>
            [session.audioKey, session.imageKey]
              .filter((key): key is string => key !== null)
              .map((key) => c.env.BUCKET.delete(key))
          )
        ).then(() => undefined)
      );
    }

    const latitude = body.latitude ?? null;
    const longitude = body.longitude ?? null;
    const geohash = latitude !== null && longitude !== null
      ? encodeGeohash(latitude, longitude)
      : null;
    const recordedAt = body.recordedAt
      ? new Date(body.recordedAt * 1000)
      : null;
    const recordedTimeZoneIdentifier = body.recordedTimeZoneIdentifier === undefined
      ? existing?.recordedTimeZoneIdentifier ?? null
      : body.recordedTimeZoneIdentifier;

    if (!existing) {
      await db.insert(recordings).values({
        id,
        userId,
        title: body.title ?? null,
        description: body.description ?? null,
        latitude,
        longitude,
        address: body.address ?? null,
        geohash,
        durationSeconds: body.durationSeconds,
        loudnessLufs: body.loudnessLufs ?? null,
        truePeakDb: body.truePeakDb ?? null,
        format: body.format,
        audioKey,
        recordedAt,
        recordedTimeZoneIdentifier,
        status: "pending",
        visibility: "private",
        createdAt: now,
        updatedAt: now,
      });
    }

    // For a replacement upload, keep the currently committed generation and
    // its visibility unchanged until complete atomically swaps in the staged
    // generation. A failed or abandoned upload must not make a live recording
    // disappear from map/search.

    await db.insert(recordingUploadSessions).values({
      id: uploadSessionId,
      recordingId: id,
      audioKey,
      imageKey,
      title: body.title ?? null,
      description: body.description ?? null,
      latitude,
      longitude,
      address: body.address ?? null,
      geohash,
      durationSeconds: body.durationSeconds,
      format: body.format,
      loudnessLufs: body.loudnessLufs ?? null,
      truePeakDb: body.truePeakDb ?? null,
      recordedAt,
      recordedTimeZoneIdentifier,
      createdAt: now,
    });

    const uploadUrl = await presignPutUrl(
      c.env,
      audioKey,
      UPLOAD_URL_EXPIRES_SECONDS
    );
    const imageUploadUrl = imageKey
      ? await presignPutUrl(c.env, imageKey, UPLOAD_URL_EXPIRES_SECONDS)
      : undefined;

    return c.json(
      {
        id,
        uploadSessionId,
        uploadUrl,
        imageUploadUrl,
        expiresIn: UPLOAD_URL_EXPIRES_SECONDS,
      },
      201
    );
  }
);

app.post(
  "/recordings/:id/upload-sessions/:sessionId/complete",
  requireAuth,
  async (c) => {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const row = await loadRecording(db, id);
    if (!row || row.userId !== c.get("userId") || row.status === "deleted") {
      return c.json({ error: "not_found" }, 404);
    }
    const sessions = await db
      .select()
      .from(recordingUploadSessions)
      .where(
        and(
          eq(recordingUploadSessions.id, c.req.param("sessionId")),
          eq(recordingUploadSessions.recordingId, id)
        )
      )
      .limit(1);
    const session = sessions[0];
    if (!session) {
      // A repeated completion after a successful commit is idempotent.
      if (row.status === "ready" && row.visibility === "public") {
        return c.json(toPublicRecording(row, { isMine: true }));
      }
      return c.json({ error: "upload_session_not_found" }, 404);
    }

    const audioHead = await c.env.BUCKET.head(session.audioKey);
    if (!audioHead) {
      return c.json({ error: "audio_not_uploaded" }, 400);
    }
    if (audioHead.size > MAX_AUDIO_BYTES) {
      await c.env.BUCKET.delete(session.audioKey);
      return c.json({ error: "file_too_large", maxBytes: MAX_AUDIO_BYTES }, 413);
    }
    if (session.imageKey && !(await c.env.BUCKET.head(session.imageKey))) {
      return c.json({ error: "image_not_uploaded" }, 400);
    }

    const oldKeys = [row.audioKey, row.imageKey].filter(
      (key): key is string => key !== null && key !== session.audioKey && key !== session.imageKey
    );
    const now = new Date();
    await db.batch([
      db
        .update(recordings)
        .set({
          title: session.title,
          description: session.description,
          latitude: session.latitude,
          longitude: session.longitude,
          address: session.address,
          geohash: session.geohash,
          durationSeconds: session.durationSeconds,
          format: session.format,
          loudnessLufs: session.loudnessLufs,
          truePeakDb: session.truePeakDb,
          recordedAt: session.recordedAt,
          recordedTimeZoneIdentifier: session.recordedTimeZoneIdentifier,
          audioKey: session.audioKey,
          imageKey: session.imageKey,
          fileSizeBytes: audioHead.size,
          status: "ready",
          visibility: "public",
          score: computeScore(row.likeCount, row.playCount, row.downloadCount, row.createdAt),
          updatedAt: now,
        })
        .where(eq(recordings.id, id)),
      db
        .delete(recordingUploadSessions)
        .where(eq(recordingUploadSessions.id, session.id)),
    ]);
    if (oldKeys.length > 0) {
      c.executionCtx.waitUntil(
        Promise.all(oldKeys.map((key) => c.env.BUCKET.delete(key))).then(() => undefined)
      );
    }
    const updated = await loadRecording(db, id);
    invalidatePublicDetailCache(c, row.id);
    return c.json(toPublicRecording(updated as RecordingRow, { isMine: true }));
  }
);

app.delete(
  "/recordings/:id/upload-sessions/:sessionId",
  requireAuth,
  async (c) => {
    const db = drizzle(c.env.DB);
    const row = await loadRecording(db, c.req.param("id"));
    if (!row || row.userId !== c.get("userId")) {
      return c.json({ error: "not_found" }, 404);
    }
    const sessions = await db
      .select()
      .from(recordingUploadSessions)
      .where(
        and(
          eq(recordingUploadSessions.id, c.req.param("sessionId")),
          eq(recordingUploadSessions.recordingId, row.id)
        )
      )
      .limit(1);
    const session = sessions[0];
    if (!session) return c.body(null, 204);
    await db
      .delete(recordingUploadSessions)
      .where(eq(recordingUploadSessions.id, session.id));
    c.executionCtx.waitUntil(
      Promise.all(
        [session.audioKey, session.imageKey]
          .filter((key): key is string => key !== null)
          .map((key) => c.env.BUCKET.delete(key))
      ).then(() => undefined)
    );
    return c.body(null, 204);
  }
);

// ---------------------------------------------------------------------------
// map (レコメンド)
// - bbox なし: 全世界から geohash 格子ごとのラウンドロビンで最大 1000 件(地理分散)
// - bbox あり: 従来のビューポート検索(ズームイン時の追加取得用)
// ※ /recordings/:id より先に定義してパスの衝突を避ける
// ---------------------------------------------------------------------------

app.get(
  "/recordings/map",
  optionalAuth,
  zValidator("query", mapQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const userId = c.get("userId");
    const db = drizzle(c.env.DB);

    if (q.minLat !== undefined) {
      const rows = await db
        .select()
        .from(recordings)
        .where(
          and(
            eq(recordings.status, "ready"),
            eq(recordings.visibility, "public"),
            isNotNull(recordings.latitude),
            isNotNull(recordings.longitude),
            isNotNull(recordings.geohash),
            gte(recordings.latitude, q.minLat),
            lte(recordings.latitude, q.maxLat as number),
            gte(recordings.longitude, q.minLng as number),
            lte(recordings.longitude, q.maxLng as number),
            userId ? ne(recordings.userId, userId) : undefined
          )
        )
        .orderBy(desc(recordings.score))
        .limit(q.limit);
      return c.json({ items: rows.map(toMapRecording) });
    }

    // グローバルモード: 匿名時だけ応答が全ユーザー共通なので Cache API を使う。
    // 認証済みの場合は本人の録音を除外するため共有キャッシュを迂回する。
    const cache = caches.default;
    const cacheKey = new Request(c.req.url);
    if (!userId) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const res = new Response(cached.body, cached);
        res.headers.set("x-cache", "HIT");
        return res;
      }
    }

    // geohash 格子(precision 3 ≈ 156km)ごとに score 順位を付け、
    // 「各セルの 1 位 → 2 位 → …」の順に採用して地理的分散を担保する。
    // 録音が特定地域に集中している間はその地域だけで埋まり、
    // 他地域に録音が増えたら少数でも必ず先に採用される。
    // スケールで遅くなったら: キャッシュ TTL 延長 → Cron で事前計算、の順で逃がす
    const cellRank = sql<number>`row_number() over (
      partition by substr(${recordings.geohash}, 1, ${MAP_CELL_PRECISION})
      order by ${recordings.score} desc
    )`.as("cell_rank");
    const ranked = db.$with("ranked").as(
      db
        .select({
          id: recordings.id,
          title: recordings.title,
          latitude: recordings.latitude,
          longitude: recordings.longitude,
          durationSeconds: recordings.durationSeconds,
          imageKey: recordings.imageKey,
          likeCount: recordings.likeCount,
          score: recordings.score,
          cellRank,
        })
        .from(recordings)
        .where(
          and(
            eq(recordings.status, "ready"),
            eq(recordings.visibility, "public"),
            isNotNull(recordings.latitude),
            isNotNull(recordings.longitude),
            isNotNull(recordings.geohash),
            userId ? ne(recordings.userId, userId) : undefined
          )
        )
    );
    const rows = await db
      .with(ranked)
      .select()
      .from(ranked)
      .orderBy(asc(ranked.cellRank), desc(ranked.score))
      .limit(q.limit);

    const res = c.json({ items: rows.map(toMapRecording) });
    if (userId) {
      res.headers.set("cache-control", "private, no-store");
    } else {
      res.headers.set("cache-control", `public, max-age=${MAP_CACHE_TTL_SECONDS}`);
      res.headers.set("x-cache", "MISS");
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return res;
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
    const userId = c.get("userId");
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
          ),
          userId ? ne(recordings.userId, userId) : undefined
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

app.get("/recordings/:id/me", requireAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const userId = c.get("userId");
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, userId)) {
    return c.json({ error: "not_found" }, 404);
  }
  const [likedByMe, reportedByMe] = await Promise.all([
    isLikedBy(db, userId, row.id),
    isReportedBy(db, userId, row.id),
  ]);
  const res = c.json({ likedByMe, reportedByMe, likeCount: row.likeCount });
  res.headers.set("cache-control", "private, no-store");
  return res;
});

app.get("/recordings/:id", async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("x-cache", "HIT");
    return res;
  }

  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || !canView(row, "")) {
    return c.json({ error: "not_found" }, 404);
  }
  const res = c.json(toPublicRecording(row));
  res.headers.set(
    "cache-control",
    `public, max-age=${DETAIL_CACHE_TTL_SECONDS}`
  );
  res.headers.set("x-cache", "MISS");
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
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
    if (body.recordedTimeZoneIdentifier !== undefined) {
      set.recordedTimeZoneIdentifier = body.recordedTimeZoneIdentifier;
    }
    if (body.latitude !== undefined && body.longitude !== undefined) {
      set.latitude = body.latitude;
      set.longitude = body.longitude;
      set.geohash = body.latitude !== null && body.longitude !== null
        ? encodeGeohash(body.latitude, body.longitude)
        : null;
    }
    await db.update(recordings).set(set).where(eq(recordings.id, row.id));

    const updated = await loadRecording(db, row.id);
    invalidatePublicDetailCache(c, row.id);
    return c.json(toPublicRecording(updated as RecordingRow, { isMine: true }));
  }
);

app.delete("/recordings/:id", requireAuth, async (c) => {
  const db = drizzle(c.env.DB);
  const row = await loadRecording(db, c.req.param("id"));
  if (!row || row.userId !== c.get("userId")) {
    return c.json({ error: "not_found" }, 404);
  }
  if (row.status === "deleted") return c.body(null, 204);
  const sessions = await db
    .select()
    .from(recordingUploadSessions)
    .where(eq(recordingUploadSessions.recordingId, row.id));
  // ソフトデリート。R2 実体の削除はレスポンスを待たせず行う
  await db
    .update(recordings)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(recordings.id, row.id));
  if (sessions.length > 0) {
    await db
      .delete(recordingUploadSessions)
      .where(eq(recordingUploadSessions.recordingId, row.id));
  }
  invalidatePublicDetailCache(c, row.id);
  c.executionCtx.waitUntil(
    Promise.all([
      c.env.BUCKET.delete(row.audioKey),
      row.imageKey ? c.env.BUCKET.delete(row.imageKey) : Promise.resolve(),
      ...sessions.flatMap((session) => [
        c.env.BUCKET.delete(session.audioKey),
        session.imageKey ? c.env.BUCKET.delete(session.imageKey) : Promise.resolve(),
      ]),
    ])
  );
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// media: image / streaming
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

  const likeInsert = db
    .insert(likes)
    .values({ userId, recordingId: row.id, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ recordingId: likes.recordingId });
  const receiptInsert = userId === row.userId
    ? null
    : db
        .insert(likeNotificationReceipts)
        .values({
          actorUserId: userId,
          recipientUserId: row.userId,
          recordingId: row.id,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ recordingId: likeNotificationReceipts.recordingId });

  const updateLikeCount = db
    .update(recordings)
    .set({
      likeCount: sql`(SELECT COUNT(*) FROM likes WHERE recording_id = ${row.id})`,
    })
    .where(eq(recordings.id, row.id));

  // いいね、通知Receipt、like_countを同一batchで確定する。
  let insertedLike: boolean;
  let insertedReceipt = false;
  if (receiptInsert) {
    const [likeRows, receiptRows] = await db.batch([
      likeInsert,
      receiptInsert,
      updateLikeCount,
    ]);
    insertedLike = likeRows.length > 0;
    insertedReceipt = receiptRows.length > 0;
  } else {
    const [likeRows] = await db.batch([likeInsert, updateLikeCount]);
    insertedLike = likeRows.length > 0;
  }
  if (insertedLike && insertedReceipt) {
    c.executionCtx.waitUntil(sendLikeNotification(c.env, {
      recipientUserId: row.userId,
      recordingId: row.id,
      recordingTitle: row.title,
    }));
  }
  await refreshScore(db, row.id);
  invalidatePublicDetailCache(c, row.id);

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
  invalidatePublicDetailCache(c, row.id);

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
      invalidatePublicDetailCache(c, row.id);
    }

    return c.json({ reported: true }, inserted.length > 0 ? 201 : 200);
  }
);

export default app;
