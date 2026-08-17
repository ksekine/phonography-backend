import { describe, expect, test } from "bun:test";
import {
  createRecordingSchema,
  keysetListQuerySchema,
  latestQuerySchema,
  updateRecordingSchema,
} from "./recordings";

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

describe("latestQuerySchema", () => {
  test("defaults the limit to the thumbnail row size", () => {
    expect(latestQuerySchema.parse({}).limit).toBe(10);
  });

  test("coerces the limit from a query string value", () => {
    expect(latestQuerySchema.parse({ limit: "20" }).limit).toBe(20);
  });

  test("clamps the limit to the allowed range", () => {
    expect(latestQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(latestQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(latestQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  test("rejects a fractional limit", () => {
    expect(latestQuerySchema.safeParse({ limit: "10.5" }).success).toBe(false);
  });
});

describe("keysetListQuerySchema", () => {
  test("defaults the limit when it is absent", () => {
    expect(keysetListQuerySchema.parse({}).limit).toBe(50);
  });

  test("clamps the limit to the allowed range", () => {
    expect(keysetListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(keysetListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(keysetListQuerySchema.parse({ limit: "100" }).limit).toBe(100);
  });

  test("accepts a composite cursor", () => {
    expect(
      keysetListQuerySchema.safeParse({
        cursor: "1784730806_4b55ae5d-4f7f-4fc1-a09d-4ca7e3f2f6bd",
      }).success
    ).toBe(true);
  });

  test("rejects a bare timestamp cursor", () => {
    // /me/recordings 形式のカーソルを取り違えて渡した場合。
    expect(keysetListQuerySchema.safeParse({ cursor: "1784730806" }).success).toBe(
      false
    );
  });

  test("rejects a cursor whose recording id is malformed", () => {
    expect(
      keysetListQuerySchema.safeParse({ cursor: "1784730806_not-a-uuid" }).success
    ).toBe(false);
    expect(
      keysetListQuerySchema.safeParse({
        cursor: "_4b55ae5d-4f7f-4fc1-a09d-4ca7e3f2f6bd",
      }).success
    ).toBe(false);
  });
});
