import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createAppContext, type AppContext } from "../src/app.ts";
import { FakeClock } from "../src/domain/clock.ts";
import { seedReferenceData } from "../src/domain/reference.ts";
import { listen } from "../src/api/http.ts";

const dir = mkdtempSync(join(tmpdir(), "foi-api-"));
let app: AppContext;
let server: Server;
let base: string;

before(async () => {
  app = createAppContext({ dbPath: join(dir, "api.db"), clock: new FakeClock("2026-02-13T09:00:00Z") });
  seedReferenceData(app.db, app.clock);
  const up = await listen(app, 0);
  server = up.server;
  base = `http://127.0.0.1:${up.port}`;
});

after(async () => {
  server.close();
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { data?: unknown; error?: { code: string; message: string } };
  return { status: res.status, json };
}

test("健康检查与目录查询", async () => {
  const h = await call("GET", "/health");
  assert.equal(h.status, 200);
  const cat = await call("GET", "/api/catalog");
  assert.ok(Array.isArray(cat.json.data));
});

test("参数校验：缺字段返回 400 + VALIDATION_ERROR；非法 JSON 同码", async () => {
  const r = await call("POST", "/api/requests", { agencyId: "agy_demo" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error?.code, "VALIDATION_ERROR");

  const res = await fetch(base + "/api/requests", { method: "POST", body: "{not-json" });
  const json = (await res.json()) as { error?: { code: string } };
  assert.equal(res.status, 400);
  assert.equal(json.error?.code, "VALIDATION_ERROR");
});

test("提交幂等 + 分页", async () => {
  const payload = {
    agencyId: "agy_demo",
    applicantId: "app_a",
    channelId: "ch_online",
    content: "API 测试申请",
    idempotencyKey: "api-1",
  };
  const a = await call("POST", "/api/requests", payload);
  const b = await call("POST", "/api/requests", payload);
  assert.equal(a.status, 200);
  assert.deepEqual((a.json.data as { id: string }).id, (b.json.data as { id: string }).id);

  const page1 = await call("GET", "/api/requests?limit=1&offset=0");
  const p1 = page1.json.data as { total: number; items: unknown[]; limit: number; offset: number };
  assert.equal(p1.limit, 1);
  assert.ok(p1.total >= 1);
  const page2 = await call("GET", "/api/requests?limit=1&offset=1");
  assert.equal((page2.json.data as { offset: number }).offset, 1);
});

test("状态机失败路径：未检索命中即答复 -> 422（无记录则 no_record 需显式空命中，这里先建一份有检索任务）", async () => {
  const created = await call("POST", "/api/requests", {
    agencyId: "agy_demo",
    applicantId: "app_b",
    channelId: "ch_post",
    content: "需要覆盖校验的申请",
  });
  const id = (created.json.data as { id: string }).id;
  await call("POST", `/api/requests/${id}/searches`, { assignee: "li" });
  const taskRow = app.db.prepare("SELECT id FROM search_task WHERE request_id=?").get(id) as { id: string };
  await call("POST", `/api/searches/${taskRow.id}/complete`, { items: ["doc_plan"] });
  const r = await call("POST", `/api/requests/${id}/answers`, { issuedBy: "w", body: "x" });
  assert.equal(r.status, 422);
  assert.equal(r.json.error?.code, "SEGMENT_COVERAGE_INCOMPLETE");
  assert.ok(Array.isArray((r.json.error as { details?: unknown }).details));
});

test("404 与 404 路由", async () => {
  const r = await call("GET", "/api/requests/req_nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error?.code, "NOT_FOUND");
  const r2 = await call("GET", "/no/such/path");
  assert.equal(r2.status, 404);
});
