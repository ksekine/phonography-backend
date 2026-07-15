import { AwsClient } from "aws4fetch";
import type { AppBindings } from "../types";

/**
 * クライアント → R2 直アップロード用の署名付き PUT URL を発行する(S3 互換 API)。
 * ダウンロード/ストリーミングは Worker 経由(バインディング)で行うため GET 用は作らない。
 */
export async function presignPutUrl(
  env: AppBindings,
  key: string,
  expiresSeconds = 3600
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  const url = new URL(
    `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`
  );
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await client.sign(new Request(url, { method: "PUT" }), {
    aws: { signQuery: true, service: "s3", region: "auto" },
  });
  return signed.url;
}
