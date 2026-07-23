import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importPKCS8, SignJWT } from "jose";
import { pushDevices } from "../db/schema";
import type { AppBindings } from "../types";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_TTL_SECONDS = 3600;

type CachedAccessToken = { value: string; expiresAt: number };
let cachedAccessToken: CachedAccessToken | null = null;

type OAuthTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

type FCMErrorResponse = {
  error?: {
    status?: unknown;
    details?: Array<{ errorCode?: unknown }>;
  };
};

export type LikeNotification = {
  recipientUserId: string;
  recordingId: string;
  recordingTitle: string | null;
};

export function buildLikeNotificationMessage(
  token: string,
  notification: Pick<LikeNotification, "recordingId" | "recordingTitle">
): Record<string, unknown> {
  const title = notification.recordingTitle?.trim();
  const alert = title
    ? {
        "title-loc-key": "LIKE_NOTIFICATION_TITLE",
        "loc-key": "LIKE_NOTIFICATION_BODY_FORMAT",
        "loc-args": [title],
      }
    : {
        "title-loc-key": "LIKE_NOTIFICATION_TITLE",
        "loc-key": "LIKE_NOTIFICATION_BODY_UNTITLED",
      };

  return {
    message: {
      token,
      data: {
        type: "recording_like",
        recordingId: notification.recordingId,
      },
      apns: {
        payload: {
          aps: {
            alert,
            sound: "default",
          },
        },
      },
    },
  };
}

async function accessToken(env: AppBindings): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt > nowSeconds + 60) {
    return cachedAccessToken.value;
  }

  const privateKey = await importPKCS8(
    env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
    "RS256"
  );
  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(env.FCM_SERVICE_ACCOUNT_EMAIL)
    .setAudience(GOOGLE_OAUTH_TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + FCM_TOKEN_TTL_SECONDS)
    .sign(privateKey);

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body: OAuthTokenResponse = await response.json();
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(`FCM OAuth token request failed (${response.status})`);
  }
  const expiresIn = typeof body.expires_in === "number"
    ? body.expires_in
    : FCM_TOKEN_TTL_SECONDS;
  cachedAccessToken = {
    value: body.access_token,
    expiresAt: nowSeconds + expiresIn,
  };
  return body.access_token;
}

function isUnregistered(body: FCMErrorResponse): boolean {
  if (body.error?.status === "NOT_FOUND") return true;
  return body.error?.details?.some(
    (detail) => detail.errorCode === "UNREGISTERED"
  ) ?? false;
}

function parseFCMError(value: unknown): FCMErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return {};
  }
  const error = value.error;
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const details = Array.isArray(record.details)
    ? record.details.flatMap((detail) => {
        if (typeof detail !== "object" || detail === null || !("errorCode" in detail)) {
          return [];
        }
        return [{ errorCode: detail.errorCode }];
      })
    : undefined;
  return { error: { status: record.status, details } };
}

export async function sendLikeNotification(
  env: AppBindings,
  notification: LikeNotification
): Promise<void> {
  const db = drizzle(env.DB);
  const devices = await db
    .select({
      installationId: pushDevices.installationId,
      fcmToken: pushDevices.fcmToken,
    })
    .from(pushDevices)
    .where(eq(pushDevices.userId, notification.recipientUserId));

  if (devices.length === 0) {
    console.log(JSON.stringify({
      event: "like_notification_skipped",
      reason: "no_registered_devices",
      recordingId: notification.recordingId,
    }));
    return;
  }

  let token: string;
  try {
    token = await accessToken(env);
  } catch (error) {
    console.error(JSON.stringify({
      event: "like_notification_auth_failed",
      recordingId: notification.recordingId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return;
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`;
  await Promise.all(devices.map(async (device) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildLikeNotificationMessage(device.fcmToken, notification)),
      });
      if (response.ok) {
        console.log(JSON.stringify({
          event: "like_notification_sent",
          recordingId: notification.recordingId,
          installationId: device.installationId,
        }));
        return;
      }

      const body = parseFCMError(await response.json().catch(() => null));
      if (isUnregistered(body)) {
        await db.delete(pushDevices).where(and(
          eq(pushDevices.installationId, device.installationId),
          eq(pushDevices.fcmToken, device.fcmToken)
        ));
      }
      console.error(JSON.stringify({
        event: "like_notification_failed",
        recordingId: notification.recordingId,
        installationId: device.installationId,
        status: response.status,
        tokenRemoved: isUnregistered(body),
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "like_notification_failed",
        recordingId: notification.recordingId,
        installationId: device.installationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }));
}
