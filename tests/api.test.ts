import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers.ts";
import { createServer, listen } from "../src/api.ts";
import type http from "node:http";

async function withServer(
  env: ReturnType<typeof makeEnv>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: http.Server = createServer(env.ctx);
  const port = await listen(server, 0);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("API：参数校验错误码与 404", async () => {
  const env = makeEnv();
  try {
    await withServer(env, async (base) => {
      const bad = await post(base, "/api/requests", {
        applicantId: "ap-anon",
        agencyId: "ag-edu",
        scopeText: "x",
        channel: "carrier-pigeon",
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, "VALIDATION_ERROR");

      const missing = await fetch(`${base}/api/requests/no-such-id`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "NOT_FOUND");

      const badPage = await fetch(`${base}/api/requests?limit=0`);
      assert.equal(badPage.status, 400);
    });
  } finally {
    env.cleanup();
  }
});

test("API：分页查询与端到端流程", async () => {
  const env = makeEnv();
  try {
    await withServer(env, async (base) => {
      for (let i = 0; i < 3; i++) {
        const r = await post(base, "/api/requests", {
          applicantId: "ap-anon",
          agencyId: "ag-edu",
          scopeText: `申请${i}`,
          channel: "online",
        });
        assert.equal(r.status, 200);
      }
      const page1 = await (await fetch(`${base}/api/requests?limit=2&offset=0`)).json();
      assert.equal(page1.total, 3);
      assert.equal(page1.items.length, 2);
      const page2 = await (await fetch(`${base}/api/requests?limit=2&offset=2`)).json();
      assert.equal(page2.items.length, 1);

      const reqId = page1.items[0].id;
      const task = await post(base, `/api/requests/${reqId}/search-tasks`, { assignee: "检索员甲" });
      assert.equal(task.body.after.status, "searching");
      const done = await post(base, `/api/search-tasks/${task.body.id}/complete`, {
        documentIds: ["doc-budget"],
      });
      assert.equal(done.body.after.status, "reviewing");
      const review = await post(base, `/api/requests/${reqId}/reviews`, {
        documentId: "doc-budget",
        reviewer: "保密员乙",
        decision: "partial",
        reason: "含个人隐私片段",
      });
      assert.equal(review.status, 200);
      const timeline = await (await fetch(`${base}/api/requests/${reqId}/timeline`)).json();
      assert.ok(timeline.events.length >= 3);
      const catalog = await (await fetch(`${base}/api/catalog?agencyId=ag-edu`)).json();
      assert.equal(catalog.total, 2);
      assert.ok(catalog.items[0].segments.length > 0);
    });
  } finally {
    env.cleanup();
  }
});
