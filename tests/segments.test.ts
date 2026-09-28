import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, submitTestRequest } from "./helpers.ts";
import { createResponse, getResponseDetail } from "../src/domain/responses.ts";

const PARTIAL = {
  summary: "部分公开答复",
  items: [
    {
      documentId: "doc-budget",
      disposition: "partial",
      basis: "《虚构公开条例》第13条",
      segments: [
        { segmentId: "seg-budget-1", disposition: "disclose", basis: "主动公开范围" },
        {
          segmentId: "seg-budget-2",
          disposition: "redact",
          basis: "个人隐私",
          redactions: [{ start: 7, end: 20 }],
        },
        { segmentId: "seg-budget-3", disposition: "withhold", basis: "内部过程性信息" },
      ],
    },
  ],
};

test("部分公开：逐项给出依据与删隐位置", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const res = createResponse(env.ctx, r.id, PARTIAL);
    const detail = getResponseDetail(env.ctx, res.id) as unknown as {
      segmentDecisions: { segment_id: string; disposition: string; redactions: string }[];
    };
    assert.equal(detail.segmentDecisions.length, 3);
    const redacted = detail.segmentDecisions.find((d) => d.segment_id === "seg-budget-2")!;
    assert.deepEqual(JSON.parse(redacted.redactions), [{ start: 7, end: 20 }]);
  } finally {
    env.cleanup();
  }
});

test("拒绝整件拒绝：缺少片段决定时校验失败", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    assert.throws(
      () =>
        createResponse(env.ctx, r.id, {
          summary: "一概拒绝",
          items: [{ documentId: "doc-budget", disposition: "withheld", basis: "保密" }],
        }),
      /every segment must have a decision/,
    );
  } finally {
    env.cleanup();
  }
});

test("删隐必须给出位置且范围合法", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const bad = structuredClone(PARTIAL);
    bad.items[0].segments[1] = { segmentId: "seg-budget-2", disposition: "redact", basis: "隐私" };
    assert.throws(() => createResponse(env.ctx, r.id, bad), /redaction positions are required/);
    const badRange = structuredClone(PARTIAL);
    badRange.items[0].segments[1].redactions = [{ start: 5, end: 9999 }];
    assert.throws(() => createResponse(env.ctx, r.id, badRange), /invalid redaction range/);
  } finally {
    env.cleanup();
  }
});

test("partial 必须同时包含公开与不公开片段", () => {
  const env = makeEnv();
  try {
    const r = submitTestRequest(env.ctx);
    const allDisclose = structuredClone(PARTIAL);
    for (const s of allDisclose.items[0].segments) {
      s.disposition = "disclose";
      delete (s as { redactions?: unknown }).redactions;
    }
    assert.throws(() => createResponse(env.ctx, r.id, allDisclose), /partial disclosure requires/);
  } finally {
    env.cleanup();
  }
});
