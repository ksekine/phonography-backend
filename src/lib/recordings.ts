import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { likes, recordings, reports } from "../db/schema";
import { computeScore } from "./score";

export const MAX_AUDIO_BYTES = 1024 * 1024 * 1024; // 1 GiB (48kHz/24bit mono の 1 時間 WAV ≈ 519MB に余裕を持たせた上限)
// マップのグローバルモードで使う geohash 格子のプレフィックス長(3 ≈ 156km 四方)
export const MAP_CELL_PRECISION = 3;
export const MAP_CACHE_TTL_SECONDS = 300;
export const DETAIL_CACHE_TTL_SECONDS = 60;
export const REPORT_HIDE_THRESHOLD = 3;
export const UPLOAD_URL_EXPIRES_SECONDS = 3600;
export const MIME: Record<"wav" | "m4a", string> = {
  wav: "audio/wav",
  m4a: "audio/mp4",
};

export type RecordingRow = typeof recordings.$inferSelect;
type DB = DrizzleD1Database;

export async function loadRecording(
  db: DB,
  id: string
): Promise<RecordingRow | undefined> {
  const rows = await db
    .select()
    .from(recordings)
    .where(eq(recordings.id, id))
    .limit(1);
  return rows[0];
}

/**
 * 参照可否。本人は deleted 以外すべて見える。
 * 他人からは ready かつ public のみ(匿名公開: 所有者情報は判定にだけ使い、露出させない)。
 */
export function canView(row: RecordingRow, userId: string): boolean {
  if (row.status === "deleted") return false;
  if (row.userId === userId) return true;
  return row.status === "ready" && row.visibility === "public";
}

/** カウンタ変更後にスコアを再計算して保存する */
export async function refreshScore(db: DB, id: string): Promise<void> {
  const rows = await db
    .select({
      likeCount: recordings.likeCount,
      playCount: recordings.playCount,
      downloadCount: recordings.downloadCount,
      createdAt: recordings.createdAt,
    })
    .from(recordings)
    .where(eq(recordings.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  await db
    .update(recordings)
    .set({
      score: computeScore(
        row.likeCount,
        row.playCount,
        row.downloadCount,
        row.createdAt
      ),
    })
    .where(eq(recordings.id, id));
}

/** play_count / download_count の加算 + スコア再計算(レスポンスを塞がないよう waitUntil から呼ぶ) */
export async function bumpCounter(
  db: DB,
  id: string,
  column: "playCount" | "downloadCount"
): Promise<void> {
  await db
    .update(recordings)
    .set({ [column]: sql`${recordings[column]} + 1` })
    .where(eq(recordings.id, id));
  await refreshScore(db, id);
}

export async function isLikedBy(
  db: DB,
  userId: string,
  recordingId: string
): Promise<boolean> {
  const rows = await db
    .select({ recordingId: likes.recordingId })
    .from(likes)
    .where(and(eq(likes.userId, userId), eq(likes.recordingId, recordingId)))
    .limit(1);
  return rows.length > 0;
}

export async function isReportedBy(
  db: DB,
  userId: string,
  recordingId: string
): Promise<boolean> {
  const rows = await db
    .select({ recordingId: reports.recordingId })
    .from(reports)
    .where(
      and(
        eq(reports.reporterUserId, userId),
        eq(reports.recordingId, recordingId)
      )
    )
    .limit(1);
  return rows.length > 0;
}
