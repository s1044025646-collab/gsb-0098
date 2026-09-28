import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export interface MigrationRecord {
  version: number;
  name: string;
}

export function openDatabase(path = process.env.FOI_DB ?? join(here, "..", "data", "foi.db")): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** 读取 SQL 文件中的纯语句（迁移脚本不含注释以外的复杂结构）。 */
function loadStatements(file: string): string[] {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const stripped = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ";");
}

/** 可重复执行：依据 PRAGMA user_version 记录已应用版本；DDL 本身也全部幂等。 */
export function migrate(db: DatabaseSync): MigrationRecord[] {
  const applied: MigrationRecord[] = [];
  const before = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const v1 = Number(before);
  if (v1 < 1) {
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const stmt of loadStatements("001_init.sql")) db.exec(stmt);
      db.exec("PRAGMA user_version = 1;");
      db.prepare(
        "INSERT INTO schema_meta(key,value) VALUES('migration_001',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(new Date(0).toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied.push({ version: 1, name: "001_init" });
  }
  return applied;
}

/** 在事务中执行读写；返回回调结果。写并发由 BEGIN IMMEDIATE + busy_timeout 串行化。 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
