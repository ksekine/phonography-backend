// 実行は常に --env dev / --env prod で行うため、環境専用バインディングを必須化する
// (typegen はトップレベル環境も含めて交差を取るので DB/BUCKET が optional になる)
export type AppBindings = CloudflareBindings & {
  DB: D1Database;
  BUCKET: R2Bucket;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    // requireAuth / optionalAuth が設定する Clerk の userId。
    // optionalAuth の匿名アクセス時は ""(どのユーザーとも一致しない)
    userId: string;
  };
};
