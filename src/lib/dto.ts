import type { recordings } from "../db/schema";

type RecordingRow = typeof recordings.$inferSelect;

/**
 * 録音の公開 DTO。
 * 匿名公開の原則: user_id・report_count 等の内部情報は絶対に含めない。
 * 所有者情報を推測させる isMine / visibility / status は本人のレスポンスにのみ載せる。
 * 日時は unix 秒(iOS 側は .secondsSince1970 でデコード)。
 */
export function toPublicRecording(
  row: RecordingRow,
  opts: { isMine?: boolean; likedByMe?: boolean } = {}
) {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    geohash: row.geohash,
    durationSeconds: row.durationSeconds,
    format: row.format,
    fileSizeBytes: row.fileSizeBytes,
    // 再生側のラウドネス正規化用(ターゲット -16 LUFS への静的ゲイン計算に使う)
    loudnessLufs: row.loudnessLufs,
    truePeakDb: row.truePeakDb,
    hasImage: row.imageKey !== null,
    likeCount: row.likeCount,
    playCount: row.playCount,
    downloadCount: row.downloadCount,
    recordedAt: row.recordedAt
      ? Math.floor(row.recordedAt.getTime() / 1000)
      : null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    ...(opts.likedByMe !== undefined ? { likedByMe: opts.likedByMe } : {}),
  };
  if (opts.isMine) {
    return {
      ...base,
      isMine: true,
      visibility: row.visibility,
      status: row.status,
    };
  }
  return base;
}

/**
 * マップピン用の軽量 DTO。
 * ユーザー固有の情報(likedByMe / isMine 等)を含めないこと —
 * マップのレスポンスは全ユーザー共有でキャッシュされる前提。
 * (引数は CTE 経由の行でも使えるよう必要カラムの Pick にしている)
 */
export function toMapRecording(
  row: Pick<
    RecordingRow,
    | "id"
    | "title"
    | "latitude"
    | "longitude"
    | "durationSeconds"
    | "imageKey"
    | "likeCount"
  >
) {
  return {
    id: row.id,
    title: row.title,
    latitude: row.latitude,
    longitude: row.longitude,
    durationSeconds: row.durationSeconds,
    hasImage: row.imageKey !== null,
    likeCount: row.likeCount,
  };
}
