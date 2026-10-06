import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";

/** SQLite-backed D1 surface for real Drizzle/auth/route integration tests. */
export async function testD1() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../../packages/db/migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).sort()) {
    const file = Bun.file(new URL(`${name}/migration.sql`, migrations));
    if (await file.exists()) sqlite.exec(await file.text());
  }
  function prepare(sql: string, params: unknown[] = []) {
    const query = sqlite.query(sql);
    return {
      bind: (...values: unknown[]) => prepare(sql, values),
      raw: async () => query.values(...(params as any[])),
      first: async () => query.get(...(params as any[])),
      all: async () => ({ success: true, results: query.all(...(params as any[])) }),
      run: async () => ({ success: true, results: [], meta: query.run(...(params as any[])) }),
    };
  }
  const DB = { prepare } as unknown as D1Database;
  const values = new Map<string, string>();
  const KV = {
    get: async (key: string, type?: string) =>
      values.has(key) ? (type === "json" ? JSON.parse(values.get(key)!) : values.get(key)) : null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  } as unknown as KVNamespace;
  return { sqlite, DB, KV };
}
