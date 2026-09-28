import { openDb } from "./db.ts";
import { SystemClock, uuidGen } from "./clock.ts";
import type { Ctx } from "./domain/common.ts";
import { seed } from "./seed.ts";
import { createServer, listen } from "./api.ts";
import {
  createApplicant,
  submitRequest,
  requestCorrection,
  receiveCorrection,
  approveExtension,
  requestView,
  listRequestVersions,
} from "./domain/requests.ts";
import { assignSearchTask, completeSearchTask } from "./domain/search.ts";
import { recordReview } from "./domain/review.ts";
import { createResponse, deliverResponse, getResponseDetail } from "./domain/responses.ts";
import { fileReconsideration, decideReconsideration } from "./domain/reconsiderations.ts";
import { getTimeline } from "./domain/timeline.ts";

const DB_PATH = process.env.FOIA_DB ?? "foia.db";

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return { cmd, flags };
}

function out(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function showTransition(result: { before?: unknown; after?: unknown } & Record<string, unknown>): void {
  const { before, after, ...rest } = result;
  if (Object.keys(rest).length > 0) out("结果", rest);
  if (before !== undefined) out("处理前状态", before);
  if (after !== undefined) out("处理后状态", after);
}

const HELP = `用法: node src/cli.ts <命令> [参数]
  migrate                                  执行可重复迁移
  seed                                     写入虚构机关/目录/假期夹具
  serve [--port 0]                         启动 API（默认自动端口）
  applicant --alias 名称                   创建匿名申请人
  submit --applicant ID --agency ID --scope 文本 --channel online|mail|in_person [--key 幂等键]
  assign --request ID --to 人员            分配检索任务
  complete-search --task ID --docs id1,id2 完成检索
  correct --request ID --note 说明         请求补正（暂停期限）
  correct-received --request ID --scope 文本  收到补正（恢复期限）
  review --request ID --document ID --reviewer 姓名 --decision disclosable|partial|withheld --reason 理由
  extend --request ID --days N --reason 理由 --approver 审批人
  respond --request ID --file response.json   生成答复（JSON 见 README）
  deliver --response ID --channel 渠道 --key 幂等键
  reconsider --request ID --response ID --reason 理由
  decide --reconsideration ID --decision uphold|change --text 说明 [--file new-response.json]
  status --request ID                      查看状态与期限
  versions --request ID                    查看申请版本留痕
  response --id ID                         查看答复明细
  timeline --request ID                    导出完整时间线 JSON
`;

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || flags.help) {
    console.log(HELP);
    return;
  }
  const ctx: Ctx = { db: openDb(DB_PATH), clock: new SystemClock(), idGen: uuidGen() };
  try {
    switch (cmd) {
      case "migrate":
        out("迁移完成（可重复执行）", { db: DB_PATH });
        break;
      case "seed":
        seed(ctx);
        out("夹具已写入", { db: DB_PATH });
        break;
      case "serve": {
        seed(ctx);
        const server = createServer(ctx);
        const port = await listen(server, flags.port ? Number(flags.port) : 0);
        console.log(`API listening on http://127.0.0.1:${port} (db: ${DB_PATH})`);
        return;
      }
      case "applicant":
        out("申请人", createApplicant(ctx, flags.alias ?? ""));
        break;
      case "submit":
        out(
          "申请",
          submitRequest(ctx, {
            applicantId: flags.applicant ?? "",
            agencyId: flags.agency ?? "",
            scopeText: flags.scope ?? "",
            channel: flags.channel ?? "",
            idempotencyKey: flags.key,
          }),
        );
        break;
      case "assign":
        showTransition(assignSearchTask(ctx, flags.request ?? "", flags.to ?? ""));
        break;
      case "complete-search":
        out(
          "检索完成",
          completeSearchTask(ctx, flags.task ?? "", (flags.docs ?? "").split(",").filter(Boolean)),
        );
        break;
      case "correct":
        showTransition(requestCorrection(ctx, flags.request ?? "", flags.note ?? ""));
        break;
      case "correct-received":
        showTransition(receiveCorrection(ctx, flags.request ?? "", flags.scope ?? ""));
        break;
      case "review":
        out(
          "保密审查",
          recordReview(ctx, flags.request ?? "", {
            documentId: flags.document ?? "",
            reviewer: flags.reviewer ?? "",
            decision: flags.decision ?? "",
            reason: flags.reason ?? "",
          }),
        );
        break;
      case "extend":
        showTransition(
          approveExtension(ctx, flags.request ?? "", {
            days: Number(flags.days),
            reason: flags.reason ?? "",
            approver: flags.approver ?? "",
          }),
        );
        break;
      case "respond": {
        const fs = await import("node:fs");
        const payload = JSON.parse(fs.readFileSync(flags.file ?? "", "utf8"));
        showTransition(createResponse(ctx, flags.request ?? "", payload));
        break;
      }
      case "deliver":
        out(
          "送达",
          deliverResponse(ctx, flags.response ?? "", {
            channel: flags.channel ?? "",
            idempotencyKey: flags.key ?? "",
          }),
        );
        break;
      case "reconsider":
        showTransition(
          fileReconsideration(ctx, flags.request ?? "", {
            responseId: flags.response ?? "",
            reason: flags.reason ?? "",
          }),
        );
        break;
      case "decide": {
        let newResponse;
        if (flags.file) {
          const fs = await import("node:fs");
          newResponse = JSON.parse(fs.readFileSync(flags.file, "utf8"));
        }
        out(
          "复议决定",
          decideReconsideration(ctx, flags.reconsideration ?? "", {
            decision: (flags.decision ?? "") as "uphold" | "change",
            decisionText: flags.text ?? "",
            newResponse,
          }),
        );
        break;
      }
      case "status":
        out("状态", requestView(ctx, flags.request ?? ""));
        break;
      case "versions":
        out("版本留痕", listRequestVersions(ctx, flags.request ?? ""));
        break;
      case "response":
        out("答复明细", getResponseDetail(ctx, flags.id ?? ""));
        break;
      case "timeline":
        out("时间线", getTimeline(ctx, flags.request ?? ""));
        break;
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    ctx.db.close();
  }
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exitCode = 1;
});
