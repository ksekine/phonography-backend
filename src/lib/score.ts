/**
 * レコメンド(マップ表示優先順位)用スコア: 人気 ÷ 時間減衰(Hacker News 型)。
 * 分子の +1 は基礎点: 反応ゼロの新着が score 0 で埋もれないようにするため
 * (新着 ≈ 0.35 > 減衰した古い低反応録音、となり新鮮さが優先される)。
 * イベント(いいね/再生/DL)時に該当行のみ再計算する。
 * 時間減衰の全件反映は将来 Workers Cron で行う(wrangler.jsonc の triggers に追加予定)。
 */
export function computeScore(
  likeCount: number,
  playCount: number,
  downloadCount: number,
  createdAt: Date,
  now = new Date()
): number {
  const ageDays = Math.max(
    0,
    (now.getTime() - createdAt.getTime()) / 86_400_000
  );
  return (
    (1 + likeCount * 3 + playCount + downloadCount * 2) /
    Math.pow(ageDays + 2, 1.5)
  );
}
