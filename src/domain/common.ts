import type { Db } from "../db.ts";
import type { Clock, IdGen } from "../clock.ts";

export interface Ctx {
  db: Db;
  clock: Clock;
  idGen: IdGen;
}

export function nowIso(ctx: Ctx): string {
  return ctx.clock.now().toISOString();
}

export function getOrThrow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} not found`);
  return row;
}
