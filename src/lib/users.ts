import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { likes, recordings, reports, users } from "../db/schema";
import type { AppBindings } from "../types";

/**
 * 退会ユーザーに紐づくデータ(録音・R2 実体・いいね・通報)の完全削除。
 * Clerk Webhook (user.deleted) から呼ばれる。全体が冪等。
 *
 * FK は意図的に NO ACTION のままにしており(誤削除の波及防止)、
 * cascade に頼らずここで明示的に子 → 親の順に削除する。
 */
export async function deleteUserData(
  env: AppBindings,
  userId: string
): Promise<void> {
  const db = drizzle(env.DB);

  const ownRecordings = await db
    .select({
      id: recordings.id,
      audioKey: recordings.audioKey,
      imageKey: recordings.imageKey,
    })
    .from(recordings)
    .where(eq(recordings.userId, userId));

  // 本人が(他人の録音に)付けたいいねの対象を控えておき、削除後に like_count を再集計する
  const likedRecordingIds = (
    await db
      .select({ recordingId: likes.recordingId })
      .from(likes)
      .where(eq(likes.userId, userId))
  ).map((r) => r.recordingId);

  // 1) R2 実体を先に削除する(DB を先に消すと、途中失敗時に孤児オブジェクトの手がかりが消える)
  const keys = ownRecordings.flatMap((r) =>
    r.imageKey ? [r.audioKey, r.imageKey] : [r.audioKey]
  );
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BUCKET.delete(keys.slice(i, i + 1000)); // R2 の一括削除上限は 1000 キー
  }

  // 2) DB を単一トランザクション(batch)で削除。FK の向きに合わせて子 → 親の順
  //    自分の録音の id 群は IN (サブクエリ) で参照し、D1 のバインド変数上限を回避する
  const ownRecordingIds = db
    .select({ id: recordings.id })
    .from(recordings)
    .where(eq(recordings.userId, userId));
  await db.batch([
    db.delete(likes).where(eq(likes.userId, userId)),
    db.delete(likes).where(inArray(likes.recordingId, ownRecordingIds)),
    db.delete(reports).where(eq(reports.reporterUserId, userId)),
    db.delete(reports).where(inArray(reports.recordingId, ownRecordingIds)),
    db.delete(recordings).where(eq(recordings.userId, userId)),
    db.delete(users).where(eq(users.id, userId)),
  ]);

  // 3) 本人がいいねしていた他人の録音の like_count を再集計
  //    (score の減衰補正は将来の Cron に任せ、ここではカウントのみ直す)
  const ownIds = new Set(ownRecordings.map((r) => r.id));
  const affected = likedRecordingIds.filter((id) => !ownIds.has(id));
  for (let i = 0; i < affected.length; i += 50) {
    await db
      .update(recordings)
      .set({
        likeCount: sql`(SELECT COUNT(*) FROM likes WHERE recording_id = recordings.id)`,
      })
      .where(inArray(recordings.id, affected.slice(i, i + 50)));
  }
}
