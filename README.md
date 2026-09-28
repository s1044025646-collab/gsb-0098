# 公共信息公开申请与复议后端（虚构数据 · 本地运行）

仅提供 API、CLI、虚构机关资料夹具与自动化测试。**不包含网页，不连接任何真实政务系统**，所有机关、资料、人员均为虚构。

## 环境要求

- Node.js >= 22.6（使用内置 `node:sqlite` 与原生 TypeScript 类型擦除，无需构建步骤）
- 运行时零依赖；`typescript`/`@types/node` 仅用于 `npm run typecheck`

## 快速开始

```powershell
npm run migrate        # 可重复执行的迁移（幂等）
npm run seed           # 写入虚构机关/资料目录/假期夹具
npm run serve          # 启动 API，默认自动端口（127.0.0.1:随机端口），-- --port 8080 可指定
npm test               # 运行全部自动化测试
npm run demo           # 可重复的端到端演示（临时数据库 + 注入时钟）
```

停止服务：在运行 `npm run serve` 的终端按 `Ctrl+C`。数据库文件默认为 `foia.db`，可用环境变量 `FOIA_DB` 指定路径。

## 领域规则

- **匿名申请人**：仅以别名建档，不采集身份信息。
- **期限**：收件日起 15 个工作日，跳过周末与 `holidays` 表中的虚构假期；补正请求→收到补正之间为明确的暂停/恢复事件，按暂停工作日顺延；延期须审批人与理由，按工作日顺延。逾期只是状态标记，不自动归责申请人。
- **部分公开**：每份答复必须对资料内**每个片段**给出处理决定（公开/删隐/不予公开）、法律依据；删隐必须给出字符区间。不允许整件资料一概拒绝。
- **留痕**：原始申请与每次补正形成 `request_versions`；每份正式答复永久保留，复议改判生成新版本并标记 `superseded_by`。
- **幂等**：提交申请与送达均支持幂等键，重复操作返回原记录。
- **事务**：所有多步写入包裹在事务（嵌套时使用 SAVEPOINT）中，失败整体回滚。
- **时间/随机性注入**：领域服务接收 `Clock` 与 `IdGen`，测试用 `FixedClock`/`seqGen`，不依赖真实等待。

## API 概览

统一错误格式：`{ "error": { "code", "message", "details" } }`，错误码：`VALIDATION_ERROR`(400)、`NOT_FOUND`(404)、`CONFLICT`(409)、`STATE_ERROR`(422)、`INTERNAL_ERROR`(500)。列表接口支持 `limit`(1-100) 与 `offset` 分页。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/applicants` | 创建匿名申请人 |
| POST | `/api/requests` | 提交申请（`idempotencyKey` 可选） |
| GET | `/api/requests?status=&limit=&offset=` | 分页查询 |
| GET | `/api/requests/:id` | 状态与期限（含 `overdue`） |
| GET | `/api/requests/:id/timeline` | 完整事件时间线 |
| GET | `/api/requests/:id/versions` | 申请版本留痕 |
| POST | `/api/requests/:id/corrections` | 请求补正（暂停期限） |
| POST | `/api/requests/:id/corrections/received` | 收到补正（恢复期限） |
| POST | `/api/requests/:id/search-tasks` | 分配检索任务 |
| POST | `/api/search-tasks/:id/complete` | 完成检索（登记命中资料） |
| POST | `/api/requests/:id/reviews` | 保密审查 |
| POST | `/api/requests/:id/extensions` | 延期（需 `days/reason/approver`） |
| POST | `/api/requests/:id/responses` | 生成答复（逐片段决定） |
| GET | `/api/responses/:id` | 答复明细（含片段决定与送达记录） |
| POST | `/api/responses/:id/deliver` | 送达（`idempotencyKey` 必填） |
| POST | `/api/requests/:id/reconsiderations` | 提起复议 |
| POST | `/api/reconsiderations/:id/decide` | 复议决定（`uphold`/`change`） |
| GET | `/api/catalog?agencyId=` | 资料目录（含片段） |

答复 `items` 结构示例见 `scripts/demo.ts` 或 `tests/segments.test.ts`。

## CLI

```powershell
node src/cli.ts <命令>   # 详见 node src/cli.ts help
```

关键操作（`submit`/`assign`/`correct`/`correct-received`/`extend`/`respond`/`reconsider` 等）会直接打印**处理前/处理后状态**。`timeline --request <id>` 导出完整时间线 JSON。

## 夹具覆盖场景

`npm run seed` 写入：虚构机关 2 个、虚构资料 3 份（含可公开与不可公开片段）、2026 年虚构国庆假期。`npm run demo` 端到端演示：跨假期期限、范围歧义补正、部分公开答复、延期后逾期、重复送达幂等、复议改判留痕。

## 测试

`npm test` 覆盖：期限计算（跨假期/暂停恢复/延期/逾期）、片段覆盖校验、版本留痕、幂等、**重启后数据库状态**与失败路径回滚、API 校验错误码与分页。测试使用临时数据库与注入时钟，可重复运行。
