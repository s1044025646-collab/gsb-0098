import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppContext, type AppContext } from "../src/app.ts";
import { FakeClock } from "../src/domain/clock.ts";
import { seedReferenceData } from "../src/domain/reference.ts";
import { computeDeadline } from "../src/domain/deadline.ts";
import { checkCoverage } from "../src/domain/review.ts";
import { exportTimeline } from "../src/domain/timeline.ts";

const dir = mkdtempSync(join(tmpdir(), "foi-e2e-"));
const dbPath = join(dir, "case.db");
let app: AppContext;
let closed = false;

before(() => {
  const clock = new FakeClock("2026-02-13T09:00:00Z"); // 周五，跨春节
  app = createAppContext({ dbPath, clock });
  seedReferenceData(app.db, clock);
});

after(() => {
  if (!closed) app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("完整流程：提交->补正暂停->检索->逐片段审查->部分公开答复->送达（含重复送达）", () => {
  const clock = app.clock as FakeClock;
  clock.set("2026-02-13T09:00:00Z");

  const r1 = app.requests.submit({
    agencyId: "agy_demo",
    applicantId: "app_a",
    channelId: "ch_online",
    content: "申请公开河滨步道改造方案及会议纪要",
    idempotencyKey: "case-1",
  });
  // 幂等：同键返回同一申请
  const r1dup = app.requests.submit({
    agencyId: "agy_demo",
    applicantId: "app_a",
    channelId: "ch_online",
    content: "不同内容但相同幂等键",
    idempotencyKey: "case-1",
  });
  assert.equal(r1dup.id, r1.id);

  // 范围歧义 -> 补正并暂停
  const clr = app.clarifications.issue(r1.id, "“相关材料”是否含第三方报价？请明确资料名称。");
  const dPaused = computeDeadline(app.db, r1.id, { today: "2026-03-02" });
  assert.equal(dPaused.pausedNow, true);
  assert.equal(dPaused.overdue, false, "暂停期间不得计逾期");

  clock.set("2026-02-24T10:00:00Z");
  app.clarifications.respond(clr.id, "仅申请改造方案与联席会议纪要，不含第三方成本材料");

  const task = app.search.assign(r1.id, "officer_li", "按名称检索");
  app.search.complete(task.id, ["doc_plan", "doc_minutes"]);

  // doc_plan：公开 / 公开 / 不予公开（逐项）
  const planSegs = app.db
    .prepare("SELECT id, label FROM item_segment WHERE catalog_item_id='doc_plan' ORDER BY start_offset")
    .all() as { id: string; label: string }[];
  app.reviews.decide(r1.id, "officer_li", {
    catalogItemId: "doc_plan",
    segmentId: planSegs[0]!.id,
    disposition: "public",
    legalBasis: "《虚构公开条例》第十九条",
    reason: "规划摘要不涉敏感信息",
  });
  app.reviews.decide(r1.id, "officer_li", {
    catalogItemId: "doc_plan",
    segmentId: planSegs[1]!.id,
    disposition: "public",
    legalBasis: "《虚构公开条例》第十九条",
    reason: "预算明细应予公开",
  });
  app.reviews.decide(r1.id, "officer_li", {
    catalogItemId: "doc_plan",
    segmentId: planSegs[2]!.id,
    disposition: "withheld",
    legalBasis: "《虚构公开条例》第二十四条第(三)项",
    reason: "谈判底价形成过程信息，公开会影响谈判秩序",
  });

  // doc_minutes：公开 + 删隐（给出字符位置）
  const minSegs = app.db
    .prepare("SELECT id, label FROM item_segment WHERE catalog_item_id='doc_minutes' ORDER BY start_offset")
    .all() as { id: string; label: string }[];
  app.reviews.decide(r1.id, "officer_li", {
    catalogItemId: "doc_minutes",
    segmentId: minSegs[0]!.id,
    disposition: "public",
    legalBasis: "《虚构公开条例》第十九条",
    reason: "会议时间议题可公开",
  });
  const secretText = "丙公司报价及成本构成属于其商业秘密，";
  app.reviews.decide(r1.id, "officer_li", {
    catalogItemId: "doc_minutes",
    segmentId: minSegs[1]!.id,
    disposition: "redacted",
    legalBasis: "《虚构公开条例》第二十四条第(二)项",
    reason: "第三方商业秘密部分删隐，其余说明性内容保留",
    redaction: { start: 0, end: secretText.length },
  });

  assert.deepEqual(checkCoverage(app.db, r1.id), { ok: true, gaps: [] });

  clock.set("2026-03-06T15:00:00Z");
  const answer = app.answers.generate(r1.id, "director_wang", "经审查，所申请资料部分公开，详见附件逐项说明。");
  assert.equal(answer.outcome, "partial");
  assert.ok(answer.items.length === 2);
  const minutesItem = (answer.items as { itemId: string; publicText: string }[]).find(
    (i) => i.itemId === "doc_minutes"
  )!;
  assert.ok(minutesItem.publicText.includes("█".repeat(secretText.length)));
  assert.ok(minutesItem.publicText.includes("不予公开，相关段落需删隐。"));

  // 送达 + 重复送达幂等
  const d1 = app.answers.deliver(answer.answerId, "ch_online", "deliver-1");
  assert.equal(d1.duplicated, false);
  const d2 = app.answers.deliver(answer.answerId, "ch_online", "deliver-1");
  assert.equal(d2.duplicated, true);

  // 期限：补正暂停 2026-02-13(发件当日)..2026-02-24 恢复
  const info = computeDeadline(app.db, r1.id, { today: "2026-03-06" });
  assert.ok(info.dueOn !== null && info.dueOn >= "2026-03-06", `不应逾期 due=${info.dueOn}`);
});

test("延期需审批；覆盖校验拒绝一概拒绝；失败路径返回错误码", () => {
  const clock = app.clock as FakeClock;
  clock.set("2026-02-20T09:00:00Z");
  const r2 = app.requests.submit({
    agencyId: "agy_demo",
    applicantId: "app_b",
    channelId: "ch_post",
    content: "申请虚构施工公告",
    idempotencyKey: "case-2",
  });
  const ext = app.extensions.request(r2.id, "跨部门协查需更多时间", 15);
  // 未批准不计入期限
  let info = computeDeadline(app.db, r2.id, { today: "2026-03-20" });
  assert.equal(info.extraWorkdays, 0);
  app.extensions.decide(ext.id, true, "deputy_zhao", "同意延期15个工作日");
  info = computeDeadline(app.db, r2.id, { today: "2026-03-20" });
  assert.equal(info.extraWorkdays, 15);

  const task = app.search.assign(r2.id, "officer_chen");
  app.search.complete(task.id, ["doc_public_notice"]);
  // 未完成全部片段审查 => 覆盖失败
  const cov = checkCoverage(app.db, r2.id);
  assert.equal(cov.ok, false);
  try {
    app.answers.generate(r2.id, "director_wang", "强行答复");
    assert.fail("应当抛错");
  } catch (e) {
    assert.equal((e as { code: string }).code, "SEGMENT_COVERAGE_INCOMPLETE");
  }
});

test("复议：受理后保留原答复，改判生成新版本且原版本仍可追溯", () => {
  const r1Row = app.db.prepare("SELECT id FROM foi_request WHERE idempotency_key='case-1'").get() as {
    id: string;
  };
  const original = app.db.prepare("SELECT * FROM answer WHERE request_id=? ORDER BY version LIMIT 1").get(r1Row.id) as {
    id: string;
    version: number;
  };
  const filed = app.reconsiderations.file(r1Row.id, "认为预算明细之外的删隐不当", "recon-1");
  assert.equal(filed.duplicated, false);
  const filedDup = app.reconsiderations.file(r1Row.id, "重复提起", "recon-1");
  assert.equal(filedDup.duplicated, true);
  app.reconsiderations.accept(filed.id);

  // 复议改判：将 minutes 第2段从 redacted 改为 public（演示变更）
  const seg = app.db
    .prepare("SELECT id FROM item_segment WHERE catalog_item_id='doc_minutes' ORDER BY start_offset DESC LIMIT 1")
    .get() as { id: string };
  app.reviews.decide(r1Row.id, "board_member", {
    catalogItemId: "doc_minutes",
    segmentId: seg.id,
    disposition: "public",
    legalBasis: "《虚构公开条例》第十九条",
    reason: "复议认为该段仅为概括说明，不构成商业秘密",
  });
  const decision = app.reconsiderations.decide(filed.id, "changed", "复议决定：变更原答复，相关片段予以公开。", "board_head");
  assert.equal(decision.result, "changed");
  assert.ok(decision.newAnswerId && decision.newAnswerId !== original.id);

  const versions = app.db.prepare("SELECT version, kind, outcome FROM answer WHERE request_id=? ORDER BY version").all(
    r1Row.id
  ) as { version: number; kind: string; outcome: string }[];
  assert.equal(versions.length, 2);
  assert.equal(versions[0]!.kind, "final");
  assert.equal(versions[1]!.kind, "reconsideration");
});

test("重启恢复：重新打开同一数据库后状态、版本、时间线完整", () => {
  app.db.close();
  closed = true;
  assert.ok(existsSync(dbPath));
  const reopened = createAppContext({ dbPath, clock: new FakeClock("2026-03-10T09:00:00Z"), autoMigrate: true });
  const r1Row = reopened.db.prepare("SELECT * FROM foi_request WHERE idempotency_key='case-1'").get() as {
    status: string;
    version: number;
    content_hash: string;
  };
  assert.equal(r1Row.status, "changed");
  assert.ok(r1Row.version >= 2);
  assert.match(r1Row.content_hash, /^[a-f0-9]{64}$/);

  const tl = exportTimeline(
    reopened.db,
    (reopened.db.prepare("SELECT id FROM foi_request WHERE idempotency_key='case-1'").get() as { id: string }).id,
    "2026-03-10"
  )!;
  const types = tl.timeline.map((e) => e.type);
  for (const need of [
    "received",
    "pause",
    "resume",
    "answer_issued",
    "reconsideration_filed",
    "reconsideration_decision",
  ]) {
    assert.ok(types.includes(need), `时间线缺少 ${need}`);
  }
  assert.equal(tl.answers.length, 2);
  // 重复迁移安全
  assert.doesNotThrow(() => reopened.db.exec("PRAGMA user_version"));
  reopened.db.close();
});
