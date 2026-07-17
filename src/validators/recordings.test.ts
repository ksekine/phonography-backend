import { describe, expect, test } from "bun:test";
import { createRecordingSchema } from "./recordings";

const base = {
  id: "4b55ae5d-4f7f-4fc1-a09d-4ca7e3f2f6bd",
  durationSeconds: 12,
  format: "m4a" as const,
  hasImage: false,
};

describe("createRecordingSchema", () => {
  test("accepts a recording without an image or location", () => {
    expect(createRecordingSchema.safeParse(base).success).toBe(true);
  });

  test("accepts a complete coordinate pair", () => {
    expect(
      createRecordingSchema.safeParse({
        ...base,
        latitude: 35.6812,
        longitude: 139.7671,
      }).success
    ).toBe(true);
  });

  test("rejects a partial coordinate pair", () => {
    expect(
      createRecordingSchema.safeParse({ ...base, latitude: 35.6812 }).success
    ).toBe(false);
  });
});
