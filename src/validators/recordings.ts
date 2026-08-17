import { z } from "zod";

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
const timeZoneIdentifierSchema = z
  .string()
  .max(255)
  .refine((identifier) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: identifier }).format();
      return true;
    } catch {
      return false;
    }
  }, { message: "invalid IANA time zone identifier" });

export const createRecordingSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(255).nullish(),
  description: z.string().max(2200).nullish(),
  latitude: latitudeSchema.nullish(),
  longitude: longitudeSchema.nullish(),
  address: z.string().max(500).nullish(),
  durationSeconds: z.number().positive().max(3600), // アプリ側の上限 1 時間
  format: z.enum(["wav", "m4a"]),
  loudnessLufs: z.number().min(-70).max(0).nullish(), // integrated loudness (LUFS)
  truePeakDb: z.number().min(-70).max(6).nullish(), // true peak (dBTP)
  recordedAt: z.number().int().positive().nullish(), // unix 秒
  recordedTimeZoneIdentifier: timeZoneIdentifierSchema.nullish(),
  hasImage: z.boolean().default(false),
}).refine(
  (v) => (v.latitude == null) === (v.longitude == null),
  { message: "latitude and longitude must be provided together" }
);

export const updateRecordingSchema = z
  .object({
    title: z.string().max(255).nullish(),
    description: z.string().max(2200).nullish(),
    address: z.string().max(500).nullish(),
    visibility: z.enum(["public", "private"]).optional(),
    latitude: latitudeSchema.nullable().optional(),
    longitude: longitudeSchema.nullable().optional(),
    recordedAt: z.number().int().positive().nullish(),
    recordedTimeZoneIdentifier: timeZoneIdentifierSchema.nullable().optional(),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: "latitude and longitude must be provided together",
  });

export const reportSchema = z.object({
  reason: z.enum(["inappropriate", "privacy", "copyright", "spam", "other"]),
  detail: z.string().max(1000).nullish(),
});

export const mapQuerySchema = z
  .object({
    // bbox は optional。指定なしはグローバルモード(geohash セル分散選抜)
    minLat: z.coerce.number().min(-90).max(90).optional(),
    maxLat: z.coerce.number().min(-90).max(90).optional(),
    minLng: z.coerce.number().min(-180).max(180).optional(),
    maxLng: z.coerce.number().min(-180).max(180).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(1000),
  })
  .refine(
    (v) => {
      const given = [v.minLat, v.maxLat, v.minLng, v.maxLng].filter(
        (x) => x !== undefined
      ).length;
      return given === 0 || given === 4;
    },
    { message: "bbox params must be all given or all omitted" }
  )
  .refine(
    (v) =>
      v.minLat === undefined ||
      (v.minLat < (v.maxLat as number) && (v.minLng as number) < (v.maxLng as number)),
    { message: "min must be less than max" }
  );

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

/**
 * 新着一覧の既定件数。iOS の横スクロール行の見え幅に合わせたもの。
 * アプリが実際に投げてくる唯一の値なので、キャッシュのパージ対象にも使う。
 */
export const LATEST_DEFAULT_LIMIT = 10;

/**
 * 新着一覧。上限を絞ってあるのは、応答が全ユーザー共有でキャッシュされる
 * = limit の値ごとにキャッシュエントリが増えるため。
 */
export const latestQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(LATEST_DEFAULT_LIMIT),
});

/**
 * キーセットページングを行う一覧の共通クエリ。
 *
 * カーソルが unix 秒単独ではなく "<秒>_<recording_id>" の複合キーなのは、
 * created_at が秒精度でタイが起きるため。lt(created_at, cursor) だけでは
 * ページ境界にまたがった同一秒の行が丸ごと欠落する。recording_id を第二キーに
 * 足して全順序にしている。
 */
export const keysetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^\d+_[0-9a-f-]{36}$/)
    .optional(),
});
