# 公共信息公开申请与复议后端（本地虚构演示）

仅使用 **TypeScript + Node.js + 内置 `node:sqlite`**，无第三方依赖、无网页、不连接任何真实政务系统。
所有机关、申请人、渠道、资料均为虚构；默认仅监听 `127.0.0.1`，端口默认由系统自动分配（`PORT=0`）。

## 能力范围

- 匿名申请人、申请范围、收件渠道、虚构资料目录（含可公开/不公开**片段**）。
- 检索任务分配与命中；范围不清可**请求补正**，补正期间以显式 `pause`/`resume` 事件暂停期限。
- 期限按**工作日历**（周末 + 虚构假期表）+ 暂停/恢复 + 已批准延期计算；暂停中不算逾期，不把逾期自动归咎申请人。
- 逐片段保密审查：`public` / `redacted`（字符级删隐位置）/ `withheld`，每项须有**依据与理由**；
  覆盖校验要求每个片段都有结论，禁止对整件资料一概拒绝。
- 延期须申请、审批、理由；不予公开须在审查中写明条款依据。
- 正式答复**不可变**并带版本号；复议受理后保留原答复，改判生成 `kind=reconsideration` 的新版本（`supersedes` 旧版）。
- 送达带幂等键，重复送达落库并标记 `duplicate`。
- 完整时间线导出：原始申请、补正、暂停/恢复、检索、延期审批、审查、答复版本、送达、复议全部可追溯。
- API 有参数校验、错误码（`VALIDATION_ERROR`/`NOT_FOUND`/`SEGMENT_COVERAGE_INCOMPLETE`/`BLANKET_DENIAL_FORBIDDEN`/`ANSWER_IMMUTABLE` 等）与分页（`limit`/`offset`，返回 `total`）。
- 时间可注入（`FakeClock`）、随机为 UUID，测试不依赖真实等待；所有写操作在 `BEGIN IMMEDIATE` 事务内，配合 WAL 与 `busy_timeout` 串行化并发写。

## 环境要求

- Node.js >= 22.5（开发验证版本 Node 25；使用内置 `node:sqlite` 与 TypeScript 类型擦除，无需 `npm install`）。

如 Node 版本提示不支持直接运行 `.ts`，可升级到 Node 24/25，或自行加入 `tsx` 作为替代加载器（本项目刻意零依赖）。

## 快速开始（PowerShell）

```powershell
cd E:\GSB\0098\A

# 1. 数据库迁移（可重复执行；依据 PRAGMA user_version，DDL 幂等）
npm run migrate

# 2. 写入虚构机关/申请人/渠道/资料夹具（幂等）
npm run seed

# 3. 启动 API（默认自动端口；启动后端口写入 data/server.pid）
npm run start

# 停止
.\bin\stop.ps1
# 或指定固定端口：
$env:PORT="3030"; npm run start
```

数据库位置可用 `FOI_DB` 覆盖，例如 `$env:FOI_DB="$PWD\data\test.db"`。

## 可重复的端到端演示

```powershell
npm run demo
```

该命令每次重建 `data/demo.db`，用固定时钟演示：跨春节虚构假期 → 范围歧义补正（期限暂停/恢复）→
检索命中两份资料 → 延期申请获批 → 逐片段审查与删隐 → 部分公开正式答复 → 送达与重复送达（幂等）→
复议受理并**改判**（保留 v1，生成 v2），最后打印完整时间线与答复版本。

## CLI 示例

关键操作（`clarify`、`extend-decide`、`review`、`answer`、`complete`）会直接打印**处理前后状态**。

```powershell
npm run cli -- help
npm run cli -- seed
npm run cli -- submit --content="申请公开河滨步道改造方案" --idempotency-key=k1
npm run cli -- list --limit=10
npm run cli -- deadline --request=req_xxx --today=2026-03-06
npm run cli -- clarify --request=req_xxx --question="请明确资料名称"
npm run cli -- assign --request=req_xxx --assignee=officer_li
npm run cli -- complete --task=task_xxx --items='["doc_plan","doc_minutes"]'
npm run cli -- review --request=req_xxx --reviewer=li --item=doc_plan `
  --segment=seg_xxx --disposition=public --basis="《虚构公开条例》第十九条" --reason="可公开"
npm run cli -- answer --request=req_xxx --by=director_wang --body="经审查部分公开"
npm run cli -- deliver --answer=ans_xxx --idempotency-key=d1
npm run cli -- appeal --request=req_xxx --reason="删隐范围过大"
npm run cli -- timeline --request=req_xxx
```

## HTTP API 摘要

启动后以 `http://127.0.0.1:<port>` 访问。成功响应：`{"data": ...}`；失败：`{"error":{"code","message","details"}}`。

- `POST /api/requests`、`GET /api/requests?status=&applicantId=&limit=&offset=`、`GET /api/requests/:id`
- `GET /api/requests/:id/deadline?today=YYYY-MM-DD`、`GET /api/requests/:id/timeline`、`GET /api/requests/:id/coverage`
- `POST /api/requests/:id/clarifications`、`POST /api/clarifications/:id/respond`
- `POST /api/requests/:id/searches`、`POST /api/searches/:id/complete`
- `POST /api/requests/:id/extensions`、`POST /api/extensions/:id/decision`
- `POST /api/request/:id/reviews`
- `POST /api/requests/:id/answers`、`GET /api/answers/:id`、`POST /api/answers/:id/deliveries`
- `POST /api/requests/:id/reconsiderations`、`POST /api/reconsiderations/:id/accept`、`POST /api/reconsiderations/:id/decision`
- `GET /api/catalog`、`POST /api/admin/seed`、`GET /health`

### curl 示例

```powershell
$base = "http://127.0.0.1:<port>"
Invoke-RestMethod "$base/api/requests" -Method Post -ContentTypeType application/json `
  -Body '{"agencyId":"agy_demo","applicantId":"app_a","channelId":"ch_online","content":"API 申请","idempotencyKey":"k1"}'
Invoke-RestMethod "$base/api/requests?limit=20&offset=0"
```

## 测试

```powershell
npm test
```

测试均使用临时目录数据库与 `FakeClock`，包含：

- 工作日历：周末、虚构假期、跨假期期限、暂停/恢复、未恢复暂停保护（`test/calendar.test.ts`）。
- 端到端业务：补正暂停、片段覆盖、删隐文本、答复版本留痕、送达幂等、复议改判、**关闭并重新打开数据库后核对状态/时间线**（`test/domain.e2e.test.ts`）。
- API：真实 HTTP 监听自动端口，校验错误码、非法 JSON、分页、422 失败路径、404（`test/api.test.ts`）。
- 并发：多连接并发写、同幂等键竞争，验证事务边界不丢数据（`test/concurrency.test.ts`）。

## 目录结构

- `migrations/001_init.sql` 可重复执行的初始结构
- `src/db.ts` 打开连接、迁移、事务封装；`src/domain/*` 领域服务
- `src/api/http.ts` 路由与校验；`src/server.ts` 启动入口
- `src/cli/*` CLI、夹具写入与端到端演示
- `fixtures/` 预留夹具说明目录（内置夹具以 `src/domain/reference.ts` 为单一事实来源）
