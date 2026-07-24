import { describe, expect, test } from "bun:test";
import {
  pushDeviceParamsSchema,
  upsertPushDeviceSchema,
} from "./pushDevices";

describe("push device validators", () => {
  test("accepts a UUID installation and token", () => {
    expect(pushDeviceParamsSchema.safeParse({
      installationId: "bb8fce5a-e62e-4470-9948-cc800fafc720",
    }).success).toBe(true);
    expect(upsertPushDeviceSchema.safeParse({ fcmToken: "token" }).success).toBe(true);
  });

  test("rejects malformed installations and oversized tokens", () => {
    expect(pushDeviceParamsSchema.safeParse({ installationId: "not-a-uuid" }).success).toBe(false);
    expect(upsertPushDeviceSchema.safeParse({ fcmToken: "x".repeat(4097) }).success).toBe(false);
  });
});
