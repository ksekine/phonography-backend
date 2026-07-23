import { describe, expect, test } from "bun:test";
import { buildLikeNotificationMessage } from "./fcm";

describe("like notification payload", () => {
  test("uses localized title and recording title body", () => {
    expect(buildLikeNotificationMessage("secret-token", {
      recordingId: "recording-id",
      recordingTitle: "Birdsong",
    })).toEqual({
      message: {
        token: "secret-token",
        data: { type: "recording_like", recordingId: "recording-id" },
        apns: { payload: { aps: { sound: "default", alert: {
          "title-loc-key": "LIKE_NOTIFICATION_TITLE",
          "loc-key": "LIKE_NOTIFICATION_BODY_FORMAT",
          "loc-args": ["Birdsong"],
        } } } },
      },
    });
  });

  test("uses the untitled localization for a blank title", () => {
    const payload = buildLikeNotificationMessage("secret-token", {
      recordingId: "recording-id",
      recordingTitle: "   ",
    });
    expect(payload).toMatchObject({ message: { apns: { payload: { aps: { alert: {
      "loc-key": "LIKE_NOTIFICATION_BODY_UNTITLED",
    } } } } } });
  });
});
