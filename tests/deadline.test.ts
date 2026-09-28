import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, submitTestRequest } from "./helpers.ts";
import { addWorkdays, loadHolidays, computeDueAt } from "../src/domain/calendar.ts";
import {
  requestCorrection,
  receiveCorrection,
  approveExtension,
  requestView,
} from "../src/domain/requests.ts";

test("跨假期：15 个工作日跳过国庆虚构假期", () => {
  const env = makeEnv("2026-09-25T09:00:00Z"); // 周五
  try {
    const r = submitTestRequest(env.ctx);
    assert.equal(r.due_at!.slice(0, 10), "2026-10-26");
  } finally {
    env.cleanup();
  }
});

test("addWorkdays 跳过周末与假期", () => {
  const env = makeEnv();
  try {
    const holidays = loadHolidays(env.ctx.db);
    const d = addWorkdays(new Date("2026-09-30T00:00:00Z"), 1, holidays);
    assert.equal(d.toISOString().slice(0, 10), "2026-10-09");
  } finally {
    env.cleanup();
  }
});

test("补正暂停/恢复事件顺延期限，不自动归责申请人", () => {
  const env = makeEnv("2026-09-25T09:00:00Z");
  try {
    const r = submitTestRequest(env.ctx);
    const baseDue = r.due_at;
    env.clock.set("2026-09-28T09:00:00Z");
    requestCorrection(env.ctx, r.id, "范围不清，请明确文号");
    env.clock.set("2026-10-12T09:00:00Z"); // 暂停跨假期
    const after = receiveCorrection(env.ctx, r.id, "明确为 EDU-2026-001 预算表");
    assert.ok(after.after.due_at! > baseDue!, "期限应顺延");
    const due = computeDueAt(env.ctx.db, r.id, new Date(after.after.received_at));
    assert.equal(due.toISOString().slice(0, 10), after.after.due_at!.slice(0, 10));
    // 顺延工作日 = 暂停期间工作日（9/29, 9/30, 10/9, 10/12 = 4 天）
    assert.equal(after.after.due_at!.slice(0, 10), "2026-10-30");
  } finally {
    env.cleanup();
  }
});

test("延期需审批人与理由，并顺延期限", () => {
  const env = makeEnv("2026-09-25T09:00:00Z");
  try {
    const r = submitTestRequest(env.ctx);
    const res = approveExtension(env.ctx, r.id, {
      days: 5,
      reason: "需跨部门核实",
      approver: "虚构分管领导",
    });
    assert.equal(res.after.due_at!.slice(0, 10), "2026-11-02");
    assert.throws(
      () => approveExtension(env.ctx, r.id, { days: 5, reason: "", approver: "x" }),
      /reason is required/,
    );
  } finally {
    env.cleanup();
  }
});

test("逾期判定：到期后未答复则 overdue", () => {
  const env = makeEnv("2026-09-25T09:00:00Z");
  try {
    const r = submitTestRequest(env.ctx);
    env.clock.set("2026-10-27T09:00:00Z");
    assert.equal(requestView(env.ctx, r.id).overdue, true);
  } finally {
    env.cleanup();
  }
});
