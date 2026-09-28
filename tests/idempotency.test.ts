import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, submitTestRequest } from "./helpers.ts";
import { createResponse, deliverResponse } from "../src/domain/responses.ts";

const FULL = {
  summary: "予以公开",
  items: [
    {
      documentId: "doc-water",
      disposition: "disclose",
      basis: "主动公开",
      segments: [
        { segmentId: "seg-water-1", disposition: "disclose", basis: "主动公开" },
        { segmentId: "seg-water-2", disposition: "disclose", basis: "主动公开" },
      ],
    },
  ],
};

test("重复送达：相同幂等键返回同一记录，不产生重复", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const resp = createResponse(env.ctx, r.id, FULL);
    const d1 = deliverResponse(env.ctx, resp.id, { channel: "online", idempotencyKey: "deliver-1" });
    const d2 = deliverResponse(env.ctx, resp.id, { channel: "online", idempotencyKey: "deliver-1" });
    assert.equal(d1.id, d2.id);
    assert.equal(d2.idempotentReplay, true);
    const count = env.ctx.db
      .prepare("SELECT COUNT(*) AS c FROM deliveries WHERE response_id = ?")
      .get(resp.id) as { c: number };
    assert.equal(count.c, 1);
  } finally {
    env.cleanup();
  }
});

test("重复提交申请：相同幂等键返回同一申请", () => {
  const env = makeEnv();
  try {
    const r1 = submitTestRequest(env.ctx, "submit-key-1");
    const r2 = submitTestRequest(env.ctx, "submit-key-1");
    assert.equal(r1.id, r2.id);
    assert.equal(r2.idempotentReplay, true);
    const count = env.ctx.db.prepare("SELECT COUNT(*) AS c FROM requests").get() as { c: number };
    assert.equal(count.c, 1);
  } finally {
    env.cleanup();
  }
});
