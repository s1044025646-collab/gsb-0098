import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const nowApplied: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations(name, applied_at) VALUES (?, ?)").run(
        m.name,
        new Date().toISOString(),
      );
    });
    nowApplied.push(m.name);
  }
  return nowApplied;
}

let txDepth = 0;
let savepointSeq = 0;

export function tx<T>(db: Db, fn: () => T): T {
  if (txDepth > 0) {
    const name = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  txDepth++;
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    txDepth--;
  }
}
