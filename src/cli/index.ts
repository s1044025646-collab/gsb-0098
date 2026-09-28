import { DomainError } from "../domain/errors.ts";
import { ensureSeeded, loadCli, parseArgs, parseJsonArray, printJson } from "./context.ts";
import { computeDeadline } from "../domain/deadline.ts";
import { exportTimeline } from "../domain/timeline.ts";
import { checkCoverage } from "../domain/review.ts";

const HELP = `
公共信息公开申请与复议后端 —— CLI（仅虚构资料，本地 SQLite）

用法:
  npm run cli -- <command> [--参数=值]

命令:
  submit       --content= --applicant=app_a --channel=ch_online --agency=agy_demo [--scope=] [--idempotency-key=] [--received-at=ISO]
  list       [--status=] [--applicant=] [--limit=20] [--offset=0]
  get        --request=
  deadline   --request= [--today=YYYY-MM-DD]
  clarify    --request= --question= [--workdays=7]
  clarify-respond --clarification= --response=
  assign     --request= --assignee= [--note=]
  complete   --task= --items='["doc_plan"]'
  extend     --request= --reason= --days=15
  extend-decide --extension= --approve=true|false --approver= --note=
  review     --request= --reviewer= --item= --segment= --disposition=public|redacted|withheld
             --basis= --reason= [--redact-start=] [--redact-end=]
  answer     --request= --by= --body=
  deliver    --answer= --channel=ch_online --idempotency-key=
  appeal     --request= --reason= [--idempotency-key=]
  appeal-accept --reconsideration=
  appeal-decide --reconsider= --result=upheld|changed --body= --by=
  timeline   --request= [--today=]
  coverage  --request=
  seed       写入虚构机关/申请人/渠道/资料目录（可重复执行）
  help
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const app = loadCli();
  ensureSeeded(app);

  try {
    switch (command) {
      case "submit": {
        const before = app.db
          .prepare("SELECT COUNT(*) AS c FROM foi_request")
          .get() as { c: number };
        const result = app.requests.submit({
          agencyId: args.agency ?? "agy_demo",
          applicantId: args.applicant ?? "app_a",
          channelId: args.channel ?? "ch_online",
          content: required(args.content, "content"),
          scopeSummary: args.scope,
          idempotencyKey: args["idempotency-key"],
          receivedAt: args["received-at"],
        });
        const after = app.db.prepare("SELECT COUNT(*) AS c FROM foi_request").get() as { c: number };
        printJson("提交前：申请总数", before);
        printJson("提交后：新申请", result);
        printJson("提交后：申请总数", after);
        break;
      }
      case "list":
        printJson(
          "申请列表",
          app.requests.list({
            status: args.status,
            applicantId: args.applicant,
            limit: args.limit ? Number(args.limit) : undefined,
            offset: args.offset ? Number(args.offset) : undefined,
          })
        );
        break;
      case "get":
        printJson("申请详情", app.db.prepare("SELECT * FROM foi_request WHERE id=?").get(required(args.request, "request")));
        break;
      case "deadline":
        printJson(
          "期限计算（工作日历 + 暂停/恢复 + 已批准延期）",
          computeDeadline(app.db, required(args.request, "request"), args.today ? { today: args.today } : {})
        );
        break;
      case "clarify": {
        const before = computeDeadline(app.db, args.request!, args.today ? { today: args.today } : {});
        const res = app.clarifications.issue(args.request!, required(args.question, "question"), args.workdays ? Number(args.workdays) : 7);
        const after = computeDeadline(app.db, args.request!, args.today ? { today: args.today } : {});
        printJson("补正前期限状态", before);
        printJson("已发出补正", res);
        printJson("补正后期限状态（已暂停，截止日待定）", after);
        break;
      }
      case "clarify-respond": {
        const res = app.clarifications.respond(required(args.clarification, "clarification"), required(args.response, "response"));
        printJson("补正回复结果（期限恢复）", res);
        break;
      }
      case "assign":
        printJson(
          "已分配检索",
          app.search.assign(args.request!, required(args.assignee, "assignee"), args.note ?? "")
        );
        break;
      case "complete": {
        const taskId = required(args.task, "task");
        const before = app.db.prepare("SELECT status FROM search_task WHERE id=?").get(taskId);
        const items = parseJsonArray(args.items);
        const after = app.search.complete(taskId, items);
        printJson("完成前任务状态", before);
        printJson("完成后检索命中", after);
        break;
      }
      case "extend":
        printJson(
          "延期申请（待审批，暂不影响期限）",
          app.extensions.request(args.request!, required(args.reason, "reason"), Number(args.days ?? "15"))
        );
        break;
      case "extend-decide": {
        const before = computeDeadline(app.db, args.request, { today: args.today });
        const res = app.extensions.decide(
          required(args.extension, "extension"),
          args.approve !== "false",
          required(args.approver, "approver"),
          required(args.note, "note")
        );
        const after = computeDeadline(app.db, args.request, { today: args.today });
        printJson("审批前期限", before);
        printJson("审批结果", res);
        printJson("审批后期限", after);
        break;
      }
      case "review": {
        const disposition = required(args.disposition, "disposition") as "public" | "redacted" | "withheld";
        const before = checkCoverage(app.db, args.request!);
        app.reviews.decide(args.request!, required(args.reviewer, "reviewer"), {
          catalogItemId: required(args.item, "item"),
          segmentId: args.segment,
          disposition,
          legalBasis: required(args.basis, "basis"),
          reason: required(args.reason, "reason"),
          redaction:
            args["redact-start"] !== undefined && args["redact-end"] !== undefined
              ? { start: Number(args["redact-start"]), end: Number(args["redact-end"]) }
              : undefined,
        });
        printJson("审查前覆盖情况", before);
        printJson("审查后覆盖情况", checkCoverage(app.db, args.request!));
        break;
      }
      case "answer": {
        const before = app.db.prepare("SELECT status, version FROM foi_request WHERE id=?").get(args.request!);
        const res = app.answers.generate(args.request!, required(args.by, "by"), required(args.body, "body"));
        const after = app.db.prepare("SELECT status, version FROM foi_request WHERE id=?").get(args.request!);
        printJson("答复前申请状态", before);
        printJson("正式答复（不可变）", res);
        printJson("答复后申请状态", after);
        break;
      }
      case "deliver": {
        const res = app.answers.deliver(
          required(args.answer, "answer"),
          args.channel ?? "ch_online",
          required(args["idempotency-key"], "idempotency-key")
        );
        printJson("送达结果（重复键标记 duplicate）", res);
        break;
      }
      case "appeal":
        printJson(
          "已提起复议（原答复保留）",
          app.reconsiderations.file(args.request!, required(args.reason, "reason"), args["idempotency-key"])
        );
        break;
      case "appeal-accept":
        printJson("复议受理", app.reconsiderations.accept(required(args.reconsideration, "reconsideration")));
        break;
      case "appeal-decide":
        printJson(
          "复议决定",
          app.reconsiderations.decide(
            required(args.reconsideration, "reconsideration"),
            required(args.result, "result") as "upheld" | "changed",
            required(args.body, "body"),
            required(args.by, "by")
          )
        );
        break;
      case "timeline":
        printJson(
          "完整时间线（原始申请/答复/复议全留痕）",
          exportTimeline(app.db, required(args.request, "request"), args.today)
        );
        break;
      case "coverage":
        printJson("片段审查覆盖校验", checkCoverage(app.db, required(args.request, "request")));
        break;
      case "seed":
        ensureSeeded(app);
        printJson("虚构夹具状态", {
          agencies: app.db.prepare("SELECT COUNT(*) c FROM agency").get(),
          channels: app.db.prepare("SELECT COUNT(*) c FROM channel").get(),
          applicants: app.db.prepare("SELECT COUNT(*) c FROM applicant").get(),
          items: app.db.prepare("SELECT COUNT(*) c FROM catalog_item").get(),
          segments: app.db.prepare("SELECT COUNT(*) c FROM item_segment").get(),
        });
        break;
      default:
        console.log(HELP);
    }
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(JSON.stringify({ error: err.code, message: err.message, details: err.details ?? null }, null, 2));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    app.db.close();
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    console.error(HELP);
    throw new Error(`缺少必填参数 --${name}`);
  }
  return value;
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
