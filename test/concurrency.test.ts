import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppContext } from "../src/app.ts";
import { FakeClock } from "../src/domain/clock.ts";
import { seedReferenceData } from "../src/domain/reference.ts";

test("并发提交不同申请：BEGIN IMMEDIATE + WAL 串行化，无 SQLITE_BUSY 丢失", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foi-conc-"));
  const path = join(dir, "c.db");
  const app = createAppContext({ dbPath: path, clock: new FakeClock("2026-02-13T09:00:00Z") });
  seedReferenceData(app.db, app.clock);

  const count = 12;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      new Promise<{ id: string }>((resolve, reject) =>
        setImmediate(() => {
          try {
            resolve(
              app.requests.submit({
                agencyId: "agy_demo",
                applicantId: "app_a",
                channelId: "ch_online",
                content: `并发申请 ${i}`,
              }) as { id: string }
            );
          } catch (e) {
            reject(e);
          }
        }, i)
      )
    )
  );
  assert.equal(new Set(results.map((r) => r.id)).size, count);
  const total = (app.db.prepare("SELECT COUNT(*) c FROM foi_request").get() as { c: number }).c;
  assert.ok(total >= count);

  // 同幂等键并发：最终只产生一条
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new Promise((resolve, reject) =>
        setImmediate(() => {
          try {
            resolve(
              app.requests.submit({
                agencyId: "agy_demo",
                applicantId: "app_a",
                channelId: "ch_online",
                content: `same ${i}`,
                idempotencyKey: "race-same-key",
              })
            );
          } catch (e) {
            reject(e);
          }
        }, i)
      )
    )
  );
  const n = (app.db.prepare("SELECT COUNT(*) c FROM foi_request WHERE idempotency_key='race-same-key'").get() as {
    c: number;
  }).c;
  assert.equal(n, 1);
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});
