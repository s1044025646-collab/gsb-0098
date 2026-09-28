/**
 * 可重复端到端演示：使用独立 data/demo.db（每次重建），
 * 注入固定时钟，覆盖跨假期、范围歧义补正、部分公开、延期审批、重复送达、复议改判。
 * 运行: npm run demo
 */
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppContext } from "../app.ts";
import { FakeClock } from "../domain/clock.ts";
import { seedReferenceData } from "../domain/reference.ts";
import { computeDeadline } from "../domain/deadline.ts";
import { exportTimeline } from "../domain/timeline.ts";

const here = dirname(fileURLToPath(import.meta.url));
const demoDb = join(here, "..", "..", "data", "demo.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(demoDb + suffix, { force: true });
  } catch {
    // 文件不存在时忽略
  }
}

const clock = new FakeClock("2026-02-13T09:00:00Z");
const app = createAppContext({ dbPath: demoDb, clock });
seedReferenceData(app.db, clock);
const log = (step: string, value?: unknown) => {
  console.log(`\n### ${step}`);
  if (value !== undefined) console.log(JSON.stringify(value, null, 2));
};

// 1) 提交（跨春节假期；范围歧义）
const req = app.requests.submit({
  agencyId: "agy_demo",
  applicantId: "app_a",
  channelId: "ch_online",
  content: "申请公开河滨步道改造的相关材料",
  idempotencyKey: "demo-request",
});
log("1. 已提交（收件 2026-02-13 周五，临近春节虚构假期）", { id: req.id, status: req.status });

// 2) 补正 -> 暂停期限
const clr = app.clarifications.issue(req.id, "“相关材料”范围不清，请明确具体资料名称。");
clock.set("2026-02-24T10:00:00Z");
app.clarifications.respond(clr.id, "明确为：改造方案与联席会议纪要");
log("2. 范围歧义补正，期间期限暂停、回复后恢复", { clarification: clr.id, dueOn: clr.dueOn });

// 3) 分配检索并完成
clock.set("2026-02-25T09:00:00Z");
const task = app.search.assign(req.id, "officer_li", "按资料名称检索");
app.search.complete(task.id, ["doc_plan", "doc_minutes"]);

// 4) 延期申请并获批（理由+审批）
const ext = app.extensions.request(req.id, "跨部门协查，资料分散", 10, "2026-02-25T12:00:00Z");
app.extensions.decide(ext.id, true, "deputy_zhao", "同意延期10个工作日", "2026-02-26T09:00:00Z");

// 5) 逐片段审查（部分公开 + 删隐位置）
const segsOf = (item: string) =>
  app.db.prepare("SELECT id, label FROM item_segment WHERE catalog_item_id=? ORDER BY start_offset").all(item) as {
    id: string;
    label: string;
  }[];
const plan = segsOf("doc_plan");
const minutes = segsOf("doc_minutes");
const reviewer = "officer_li";
app.reviews.decide(req.id, reviewer, { catalogItemId: "doc_plan", segmentId: plan[0]!.id, disposition: "public", legalBasis: "《虚构公开条例》第十九条", reason: "规划摘要可公开" });
app.reviews.decide(req.id, reviewer, { catalogItemId: "doc_plan", segmentId: plan[1]!.id, disposition: "public", legalBasis: "《虚构公开条例》第十九条", reason: "预算明细可公开" });
app.reviews.decide(req.id, reviewer, { catalogItemId: "doc_plan", segmentId: plan[2]!.id, disposition: "withheld", legalBasis: "《虚构公开条例》第二十四条第(三)项", reason: "未公开谈判底价，过程性信息不予公开" });
app.reviews.decide(req.id, reviewer, { catalogItemId: "doc_minutes", segmentId: minutes[0]!.id, disposition: "public", legalBasis: "《虚构公开条例》第十九条", reason: "时间议题可公开" });
const redacted = "丙公司报价及成本构成属于其商业秘密，";
app.reviews.decide(req.id, reviewer, {
  catalogItemId: "doc_minutes",
  segmentId: minutes[1]!.id,
  disposition: "redacted",
  legalBasis: "《虚构公开条例》第二十四条第(二)项",
  reason: "商业秘密部分删隐",
  redaction: { start: 0, end: redacted.length },
});

// 6) 生成正式答复
clock.set("2026-03-13T15:00:00Z");
const answer = app.answers.generate(req.id, "director_wang", "经审查，所申请资料部分公开，详见逐项处理依据与删隐位置。");
log("3. 正式答复（逐项依据+删隐，outcome=partial）", {
  answerId: answer.answerId,
  version: answer.version,
  outcome: answer.outcome,
  items: (answer.items as { title: string; disposition: string; publicText: string }[]).map((i) => ({
    title: i.title,
    disposition: i.disposition,
    publicText: i.publicText,
  })),
});
log("4. 期限（含假期/暂停/批准延期）", computeDeadline(app.db, req.id, { today: "2026-03-13" }));

// 7) 送达 + 重复送达
const d1 = app.answers.deliver(answer.answerId, "ch_online", "demo-deliver-1");
const d2 = app.answers.deliver(answer.answerId, "ch_post", "demo-deliver-1");
log("5. 送达与重复送达（第二次幂等标记 duplicate）", { first: d1, repeat: d2 });

// 8) 复议：受理 -> 改判（保留原答复，生成新版本）
clock.set("2026-03-16T09:00:00Z");
const rec = app.reconsiderations.file(req.id, "申请人认为会议纪要删隐范围过大", "demo-appeal");
app.reconsiderations.accept(rec.id);
app.reviews.decide(req.id, "board_member", {
  catalogItemId: "doc_minutes",
  segmentId: minutes[1]!.id,
  disposition: "redacted",
  legalBasis: "《虚构公开条例》第二十四条第(二)项",
  reason: "复议后仅删隐报价数字相关表述，其余公开",
  redaction: { start: 0, end: 5 },
});
const decision = app.reconsiderations.decide(rec.id, "changed", "复议决定：变更原答复，缩小删隐范围。", "board_head");
log("6. 复议改判（原答复保留，新版本 supersedes 旧版）", decision);

const tl = exportTimeline(app.db, req.id, "2026-03-16")!;
log("7. 完整时间线事件序列", tl.timeline.map((e) => ({ seq: e.seq, type: e.type, at: e.occurredAt, actor: e.actor })));
log("8. 答复版本留痕", (tl.answers as { version: number; kind: string; outcome: string }[]));
console.log(`\n演示数据库: ${demoDb}`);
console.log("查看完整时间线: npm run cli -- timeline --request=" + req.id);
app.db.close();
