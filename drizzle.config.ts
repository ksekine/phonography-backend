import { defineConfig } from 'drizzle-kit'

// マイグレーション SQL の生成のみに使う (bun run db:generate)。
// 適用は wrangler d1 migrations apply (db:migrate:*) で行う。
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
