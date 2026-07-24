import { describe, expect, test } from "bun:test";
import app from "../index";

describe("recording viewer state", () => {
  test("requires authentication", async () => {
    const response = await app.request("/api/recordings/recording-id/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
