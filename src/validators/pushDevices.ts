import { z } from "zod";

export const pushDeviceParamsSchema = z.object({
  installationId: z.string().uuid(),
});

export const upsertPushDeviceSchema = z.object({
  fcmToken: z.string().trim().min(1).max(4096),
});
