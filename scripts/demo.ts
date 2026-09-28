import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { FixedClock, seqGen } from "../src/clock.ts";
import type { Ctx } from "../src/domain/common.ts";
import { seed } from "../src/seed.ts";
import {
  submitRequest,
  requestCorrection,
  receiveCorrection,
  approveExtension,
  requestView,
} from "../src/domain/requests.ts";
import { assignSearchTask, completeSearchTask } from "../src/domain/search.ts";
import { recordReview } from "../src/domain/review.ts";
import { createResponse, deliverResponse } from "../src/domain/responses.ts";
import { fileReconsideration, decideReconsideration } from "../src/domain/reconsiderations.ts";
import { getTimeline } from "../src/domain/timeline.ts";

const dir = mkdtempSync(join(tmpdir(), "foia-demo-"));
const clock = new FixedClock("2026-09-25T09:00:00Z");
const ctx: Ctx = { db: openDb(join(dir, "demo.db")), clock, idGen: seqGen("demo") };
seed(ctx);

function step(title: string, value: unknown): void {
  console.log(`\n### ${title}`);
  console.log(JSON.stringify(value, null, 2));
}

// 场景 1+2：跨假期提交 + 范围歧义 -> 补正（暂停/恢复期限）
const req = submitRequest(ctx, {
  applicantId: "ap-anon",
  agencyId: "ag-edu",
  scopeText: "申请公开教育局全部预算（范围模糊）",
  channel: "online",
  idempotencyKey: "demo-submit-1",
});
step("1. 提交申请（跨国庆假期，15 工作日期限）", req);

assignSearchTask(ctx, req.id, "虚构检索员甲");
clock.set("2026-09-28T09:00:00Z");
step("2. 范围歧义 -> 请求补正（期限暂停）", requestCorrection(ctx, req.id, "请明确具体文件或文号"));
clock.set("2026-10-12T09:00:00Z");
step("3. 收到补正（期限恢复并顺延）", receiveCorrection(ctx, req.id, "明确为 EDU-2026-001 预算表"));

const task = ctx.db
  .prepare("SELECT id FROM search_tasks WHERE request_id = ?")
  .get(req.id) as { id: string };
completeSearchTask(ctx, task.id, ["doc-budget"]);

// 场景 3：部分公开，逐片段依据 + 删隐位置
recordReview(ctx, req.id, {
  documentId: "doc-budget",
  reviewer: "虚构保密员乙",
  decision: "partial",
  reason: "含个人隐私与内部过程性信息",
});
const resp = createResponse(ctx, req.id, {
  summary: "部分公开：预算总额公开，个人信息删隐，内部意见不予公开",
  items: [
    {
      documentId: "doc-budget",
      disposition: "partial",
      basis: "《虚构政府信息公开条例》第13、14、16条",
      segments: [
        { segmentId: "seg-budget-1", disposition: "disclose", basis: "第13条：主动公开范围" },
        {
          segmentId: "seg-budget-2",
          disposition: "redact",
          basis: "第14条：个人隐私",
          redactions: [{ start: 7, end: 20 }],
        },
        { segmentId: "seg-budget-3", disposition: "withhold", basis: "第16条：过程性信息" },
      ],
    },
  ],
});
step("4. 生成答复（部分公开，逐片段依据）", resp);

// 场景 5：重复送达幂等
const d1 = deliverResponse(ctx, resp.id, { channel: "online", idempotencyKey: "demo-deliver-1" });
const d2 = deliverResponse(ctx, resp.id, { channel: "online", idempotencyKey: "demo-deliver-1" });
step("5. 重复送达（幂等）", { first: d1, replay: d2 });

// 场景 6：复议改判，保留原答复
const rec = fileReconsideration(ctx, req.id, {
  responseId: resp.id,
  reason: "申请人认为内部评审意见应予公开",
});
const decided = decideReconsideration(ctx, rec.id, {
  decision: "change",
  decisionText: "内部评审意见与预算执行直接相关，变更为公开该片段",
  newResponse: {
    summary: "复议变更：除个人隐私外全部公开",
    items: [
      {
        documentId: "doc-budget",
        disposition: "partial",
        basis: "《虚构政府信息公开条例》第13、14条",
        segments: [
          { segmentId: "seg-budget-1", disposition: "disclose", basis: "第13条" },
          {
            segmentId: "seg-budget-2",
            disposition: "redact",
            basis: "第14条：个人隐私",
            redactions: [{ start: 7, end: 20 }],
          },
          { segmentId: "seg-budget-3", disposition: "disclose", basis: "复议决定：与履职直接相关" },
        ],
      },
    ],
  },
});
step("6. 复议改判（原答复保留，新答复版本 v2）", decided);

// 场景 4：延期与逾期
clock.set("2026-09-25T09:00:00Z");
const req2 = submitRequest(ctx, {
  applicantId: "ap-anon",
  agencyId: "ag-env",
  scopeText: "申请公开2026年8月水质监测月报",
  channel: "mail",
});
approveExtension(ctx, req2.id, { days: 5, reason: "需第三方机构核实数据", approver: "虚构所长" });
clock.set("2026-11-10T09:00:00Z");
step("7. 延期后仍逾期（overdue=true）", requestView(ctx, req2.id));

// 完整时间线导出
step("8. 完整时间线（申请 1）", getTimeline(ctx, req.id));

ctx.db.close();
console.log(`\n演示数据库: ${dir}\\demo.db`);
