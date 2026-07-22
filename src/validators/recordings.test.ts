import { describe, expect, test } from "bun:test";
import { createRecordingSchema, updateRecordingSchema } from "./recordings";

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

  test("accepts an IANA recording time zone", () => {
    expect(
      createRecordingSchema.safeParse({
        ...base,
        recordedTimeZoneIdentifier: "America/New_York",
      }).success
    ).toBe(true);
  });

  test("rejects an invalid recording time zone", () => {
    expect(
      createRecordingSchema.safeParse({
        ...base,
        recordedTimeZoneIdentifier: "Not/A_Zone",
      }).success
    ).toBe(false);
  });
});

describe("updateRecordingSchema", () => {
  test("distinguishes an omitted time zone from an explicit null", () => {
    const omitted = updateRecordingSchema.parse({});
    const cleared = updateRecordingSchema.parse({
      recordedTimeZoneIdentifier: null,
    });

    expect("recordedTimeZoneIdentifier" in omitted).toBe(false);
    expect(cleared.recordedTimeZoneIdentifier).toBeNull();
  });
});
