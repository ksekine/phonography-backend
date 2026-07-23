// 実行は常に --env dev / --env prod で行うため、環境専用バインディングを必須化する
// (typegen はトップレベル環境も含めて交差を取るので DB/BUCKET が optional になる)
export type AppBindings = CloudflareBindings & {
  DB: D1Database;
  BUCKET: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  FCM_SERVICE_ACCOUNT_EMAIL: string;
  FCM_SERVICE_ACCOUNT_PRIVATE_KEY: string;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    // requireAuth / optionalAuth が設定する Firebase の UID。
    // optionalAuth の匿名アクセス時は ""(どのユーザーとも一致しない)
    userId: string;
  };
};
