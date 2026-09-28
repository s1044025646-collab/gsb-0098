import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.ts";
import { FixedClock, seqGen } from "../src/clock.ts";
import type { Ctx } from "../src/domain/common.ts";
import { seed } from "../src/seed.ts";
import { submitRequest } from "../src/domain/requests.ts";

export interface TestEnv {
  ctx: Ctx;
  clock: FixedClock;
  dbPath: string;
  dir: string;
  cleanup(): void;
  reopen(): Ctx;
}

export function makeEnv(startIso = "2026-09-25T09:00:00Z"): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "foia-test-"));
  const dbPath = join(dir, "test.db");
  const clock = new FixedClock(startIso);
  let n = 0;
  const mkCtx = (db: Db): Ctx => ({ db, clock, idGen: seqGen(`t${++n}`) });
  const db = openDb(dbPath);
  const ctx = mkCtx(db);
  seed(ctx);
  return {
    ctx,
    clock,
    dbPath,
    dir,
    cleanup() {
      try {
        ctx.db.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
    reopen() {
      ctx.db.close();
      const db2 = openDb(dbPath);
      const ctx2 = mkCtx(db2);
      ctx.db = db2;
      return ctx2;
    },
  };
}

export function submitTestRequest(ctx: Ctx, key?: string) {
  return submitRequest(ctx, {
    applicantId: "ap-anon",
    agencyId: "ag-edu",
    scopeText: "申请公开2026年虚构教材采购预算表",
    channel: "online",
    idempotencyKey: key,
  });
}
