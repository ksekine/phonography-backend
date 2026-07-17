import { z } from "zod";

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);

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

export const myListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().positive().optional(), // 前ページ末尾の createdAt (unix 秒)
});
