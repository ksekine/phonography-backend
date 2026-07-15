import { z } from "zod";

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);

export const createRecordingSchema = z.object({
  title: z.string().max(255).nullish(),
  description: z.string().max(2200).nullish(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  address: z.string().max(500).nullish(),
  durationSeconds: z.number().positive().max(3600), // アプリ側の上限 1 時間
  format: z.enum(["wav", "m4a"]),
  recordedAt: z.number().int().positive().nullish(), // unix 秒
  hasImage: z.boolean().default(false),
});

export const updateRecordingSchema = z
  .object({
    title: z.string().max(255).nullish(),
    description: z.string().max(2200).nullish(),
    address: z.string().max(500).nullish(),
    visibility: z.enum(["public", "private"]).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
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
    minLat: z.coerce.number().min(-90).max(90),
    maxLat: z.coerce.number().min(-90).max(90),
    minLng: z.coerce.number().min(-180).max(180),
    maxLng: z.coerce.number().min(-180).max(180),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .refine((v) => v.minLat < v.maxLat && v.minLng < v.maxLng, {
    message: "min must be less than max",
  });

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

export const myListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().positive().optional(), // 前ページ末尾の createdAt (unix 秒)
});
