import { tx } from "../db.ts";
import { ApiError } from "../errors.ts";
import { getRequest, requestView } from "./requests.ts";
import { nowIso, type Ctx } from "./common.ts";

export const ITEM_DISPOSITIONS = ["disclose", "partial", "withheld", "not_found"] as const;
export const SEGMENT_DISPOSITIONS = ["disclose", "redact", "withhold"] as const;

export interface SegmentDecisionInput {
  segmentId: string;
  disposition: string;
  basis: string;
  redactions?: { start: number; end: number }[];
}

export interface ResponseItemInput {
  documentId: string;
  disposition: string;
  basis: string;
  segments?: SegmentDecisionInput[];
}

function validateItem(ctx: Ctx, item: ResponseItemInput): void {
  if (!ITEM_DISPOSITIONS.includes(item.disposition as never))
    throw ApiError.validation(`disposition must be one of ${ITEM_DISPOSITIONS.join(",")}`);
  if (!item.basis) throw ApiError.validation("basis is required for every item");
  if (item.disposition === "not_found") return;
  const segments = ctx.db
    .prepare("SELECT id, content FROM document_segments WHERE document_id = ? ORDER BY seq")
    .all(item.documentId) as { id: string; content: string }[];
  if (segments.length === 0) throw ApiError.notFound(`document ${item.documentId}`);
  const decisions = item.segments ?? [];
  const byId = new Map(decisions.map((d) => [d.segmentId, d]));
  const missing = segments.filter((s) => !byId.has(s.id)).map((s) => s.id);
  if (missing.length > 0)
    throw ApiError.validation("every segment must have a decision; whole-document refusal is not allowed", {
      documentId: item.documentId,
      missingSegmentIds: missing,
    });
  const contentById = new Map(segments.map((s) => [s.id, s.content]));
  let disclosed = 0;
  let hidden = 0;
  for (const d of decisions) {
    const content = contentById.get(d.segmentId);
    if (content === undefined)
      throw ApiError.validation(`segment ${d.segmentId} does not belong to document ${item.documentId}`);
    if (!SEGMENT_DISPOSITIONS.includes(d.disposition as never))
      throw ApiError.validation(`segment disposition must be one of ${SEGMENT_DISPOSITIONS.join(",")}`);
    if (!d.basis) throw ApiError.validation(`basis is required for segment ${d.segmentId}`);
    if (d.disposition === "redact") {
      if (!d.redactions || d.redactions.length === 0)
        throw ApiError.validation(`redaction positions are required for segment ${d.segmentId}`);
      for (const r of d.redactions) {
        if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > content.length)
          throw ApiError.validation(`invalid redaction range for segment ${d.segmentId}`, {
            range: r,
            segmentLength: content.length,
          });
      }
    }
    if (d.disposition === "disclose") disclosed++;
    else hidden++;
  }
  if (item.disposition === "partial" && (disclosed === 0 || hidden === 0))
    throw ApiError.validation("partial disclosure requires at least one disclosed and one redacted/withheld segment");
  if (item.disposition === "disclose" && hidden > 0)
    throw ApiError.validation("disposition 'disclose' conflicts with redacted/withheld segments");
  if (item.disposition === "withheld" && disclosed > 0)
    throw ApiError.validation("disposition 'withheld' conflicts with disclosed segments");
}

export function createResponse(
  ctx: Ctx,
  requestId: string,
  input: { summary: string; items: ResponseItemInput[] },
  opts: { finalize?: boolean } = {},
) {
  if (!input.summary) throw ApiError.validation("summary is required");
  if (!Array.isArray(input.items) || input.items.length === 0)
    throw ApiError.validation("items must be a non-empty array");
  return tx(ctx.db, () => {
    const r = getRequest(ctx, requestId);
    if (r.status === "awaiting_correction")
      throw ApiError.state("request is awaiting correction");
    for (const item of input.items) validateItem(ctx, item);
    const before = requestView(ctx, requestId);
    const maxV = ctx.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM responses WHERE request_id = ?")
      .get(requestId) as { v: number };
    const id = ctx.idGen();
    ctx.db
      .prepare(
        "INSERT INTO responses(id, request_id, version, status, summary, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, requestId, maxV.v + 1, opts.finalize === false ? "draft" : "final", input.summary, nowIso(ctx));
    for (const item of input.items) {
      ctx.db
        .prepare(
          "INSERT INTO response_items(id, response_id, document_id, disposition, basis) VALUES (?,?,?,?,?)",
        )
        .run(ctx.idGen(), id, item.documentId, item.disposition, item.basis);
      for (const seg of item.segments ?? []) {
        ctx.db
          .prepare(
            "INSERT INTO segment_decisions(id, response_id, segment_id, disposition, basis, redactions) VALUES (?,?,?,?,?,?)",
          )
          .run(
            ctx.idGen(),
            id,
            seg.segmentId,
            seg.disposition,
            seg.basis,
            JSON.stringify(seg.redactions ?? []),
          );
      }
    }
    ctx.db
      .prepare("UPDATE requests SET status = 'responded', updated_at = ? WHERE id = ?")
      .run(nowIso(ctx), requestId);
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(ctx.idGen(), requestId, "response_issued", nowIso(ctx), JSON.stringify({ responseId: id }));
    return { id, before, after: requestView(ctx, requestId) };
  });
}

export function getResponseDetail(ctx: Ctx, responseId: string) {
  const response = ctx.db.prepare("SELECT * FROM responses WHERE id = ?").get(responseId);
  if (!response) throw ApiError.notFound(`response ${responseId}`);
  const items = ctx.db
    .prepare("SELECT * FROM response_items WHERE response_id = ?")
    .all(responseId) as { id: string; document_id: string }[];
  const decisions = ctx.db
    .prepare("SELECT * FROM segment_decisions WHERE response_id = ?")
    .all(responseId);
  const deliveries = ctx.db
    .prepare("SELECT * FROM deliveries WHERE response_id = ?")
    .all(responseId);
  return { ...(response as object), items, segmentDecisions: decisions, deliveries };
}

export function deliverResponse(
  ctx: Ctx,
  responseId: string,
  input: { channel: string; idempotencyKey: string },
) {
  if (!input.channel) throw ApiError.validation("channel is required");
  if (!input.idempotencyKey) throw ApiError.validation("idempotencyKey is required");
  return tx(ctx.db, () => {
    const response = ctx.db
      .prepare("SELECT * FROM responses WHERE id = ?")
      .get(responseId) as { id: string; status: string; request_id: string } | undefined;
    if (!response) throw ApiError.notFound(`response ${responseId}`);
    if (response.status !== "final") throw ApiError.state("only final responses can be delivered");
    const dup = ctx.db
      .prepare("SELECT * FROM deliveries WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as { id: string } | undefined;
    if (dup) return { id: dup.id, idempotentReplay: true };
    const id = ctx.idGen();
    ctx.db
      .prepare(
        "INSERT INTO deliveries(id, response_id, channel, idempotency_key, delivered_at) VALUES (?,?,?,?,?)",
      )
      .run(id, responseId, input.channel, input.idempotencyKey, nowIso(ctx));
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(
        ctx.idGen(),
        response.request_id,
        "response_delivered",
        nowIso(ctx),
        JSON.stringify({ responseId, channel: input.channel }),
      );
    return { id, idempotentReplay: false };
  });
}
