import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, submitTestRequest } from "./helpers.ts";
import {
  requestCorrection,
  receiveCorrection,
  requestView,
  approveExtension,
} from "../src/domain/requests.ts";
import { assignSearchTask } from "../src/domain/search.ts";
import { getTimeline } from "../src/domain/timeline.ts";

test("重启后数据库状态完整恢复", () => {
  const env = makeEnv("2026-09-25T09:00:00Z");
  try {
    const r = submitTestRequest(env.ctx);
    assignSearchTask(env.ctx, r.id, "虚构检索员");
    requestCorrection(env.ctx, r.id, "范围不清");
    env.clock.set("2026-09-30T09:00:00Z");
    receiveCorrection(env.ctx, r.id, "明确后的范围");
    const dueBefore = requestView(env.ctx, r.id).due_at;

    env.reopen();

    const view = requestView(env.ctx, r.id);
    assert.equal(view.due_at, dueBefore);
    assert.equal(view.status, "received");
    assert.equal(view.version, 2);
    const timeline = getTimeline(env.ctx, r.id) as { events: { type: string }[] };
    assert.deepEqual(
      timeline.events.map((e) => e.type),
      ["submitted", "search_assigned", "correction_requested", "correction_received"],
    );
  } finally {
    env.cleanup();
  }
});

test("失败路径：事务回滚不留部分写入", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const eventsBefore = (
      env.ctx.db.prepare("SELECT COUNT(*) AS c FROM request_events WHERE request_id = ?").get(r.id) as { c: number }
    ).c;
    // 补正收到时状态非法 -> 整个事务应回滚
    assert.throws(() => receiveCorrection(env.ctx, r.id, "x"), /not awaiting correction/);
    const eventsAfter = (
      env.ctx.db.prepare("SELECT COUNT(*) AS c FROM request_events WHERE request_id = ?").get(r.id) as { c: number }
    ).c;
    assert.equal(eventsAfter, eventsBefore);
    assert.equal(requestView(env.ctx, r.id).version, 1);
    // 延期参数非法 -> 无 extensions 记录
    assert.throws(() => approveExtension(env.ctx, r.id, { days: 0, reason: "x", approver: "y" }));
    const extCount = (
      env.ctx.db.prepare("SELECT COUNT(*) AS c FROM extensions WHERE request_id = ?").get(r.id) as { c: number }
    ).c;
    assert.equal(extCount, 0);
  } finally {
    env.cleanup();
  }
});
