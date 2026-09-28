import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, submitTestRequest } from "./helpers.ts";
import {
  requestCorrection,
  receiveCorrection,
  listRequestVersions,
} from "../src/domain/requests.ts";
import { createResponse } from "../src/domain/responses.ts";
import { fileReconsideration, decideReconsideration } from "../src/domain/reconsiderations.ts";

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

test("原始申请版本在补正后仍可追溯", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    requestCorrection(env.ctx, r.id, "范围不清");
    receiveCorrection(env.ctx, r.id, "明确后的范围");
    const versions = listRequestVersions(env.ctx, r.id) as { version: number; scope_text: string }[];
    assert.equal(versions.length, 2);
    assert.equal(versions[0].scope_text, "申请公开2026年虚构教材采购预算表");
    assert.equal(versions[1].scope_text, "明确后的范围");
  } finally {
    env.cleanup();
  }
});

test("复议改判保留原答复并生成新版本", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const resp1 = createResponse(env.ctx, r.id, {
      summary: "不予公开",
      items: [
        {
          documentId: "doc-water",
          disposition: "withheld",
          basis: "虚构保密规定第3条",
          segments: [
            { segmentId: "seg-water-1", disposition: "withhold", basis: "保密" },
            { segmentId: "seg-water-2", disposition: "withhold", basis: "保密" },
          ],
        },
      ],
    });
    const rec = fileReconsideration(env.ctx, r.id, { responseId: resp1.id, reason: "适用法律错误" });
    const decided = decideReconsideration(env.ctx, rec.id, {
      decision: "change",
      decisionText: "原答复依据不足，变更为予以公开",
      newResponse: FULL,
    });
    assert.ok(decided.newResponseId);
    const original = env.ctx.db
      .prepare("SELECT * FROM responses WHERE id = ?")
      .get(resp1.id) as { summary: string; superseded_by: string };
    assert.equal(original.summary, "不予公开", "原答复内容保留");
    assert.equal(original.superseded_by, decided.newResponseId);
    const versions = env.ctx.db
      .prepare("SELECT version FROM responses WHERE request_id = ? ORDER BY version")
      .all(r.id) as { version: number }[];
    assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  } finally {
    env.cleanup();
  }
});

test("复议维持不生成新答复", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const resp1 = createResponse(env.ctx, r.id, FULL);
    const rec = fileReconsideration(env.ctx, r.id, { responseId: resp1.id, reason: "不服" });
    const decided = decideReconsideration(env.ctx, rec.id, {
      decision: "uphold",
      decisionText: "原答复认定事实清楚，予以维持",
    });
    assert.equal(decided.newResponseId, null);
    const count = env.ctx.db
      .prepare("SELECT COUNT(*) AS c FROM responses WHERE request_id = ?")
      .get(r.id) as { c: number };
    assert.equal(count.c, 1);
  } finally {
    env.cleanup();
  }
});
