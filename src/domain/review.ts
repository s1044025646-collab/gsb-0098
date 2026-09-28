import { tx } from "../db.ts";
import { ApiError } from "../errors.ts";
import { getRequest } from "./requests.ts";
import { nowIso, type Ctx } from "./common.ts";

export const REVIEW_DECISIONS = ["disclosable", "partial", "withheld"] as const;

export function recordReview(
  ctx: Ctx,
  requestId: string,
  input: { documentId: string; reviewer: string; decision: string; reason: string },
) {
  if (!input.reviewer) throw ApiError.validation("reviewer is required");
  if (!input.reason) throw ApiError.validation("reason is required");
  if (!REVIEW_DECISIONS.includes(input.decision as never))
    throw ApiError.validation(`decision must be one of ${REVIEW_DECISIONS.join(",")}`);
  return tx(ctx.db, () => {
    getRequest(ctx, requestId);
    const doc = ctx.db.prepare("SELECT id FROM documents WHERE id = ?").get(input.documentId);
    if (!doc) throw ApiError.notFound(`document ${input.documentId}`);
    const id = ctx.idGen();
    ctx.db
      .prepare(
        "INSERT INTO reviews(id, request_id, document_id, reviewer, decision, reason, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, requestId, input.documentId, input.reviewer, input.decision, input.reason, nowIso(ctx));
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(
        ctx.idGen(),
        requestId,
        "review_recorded",
        nowIso(ctx),
        JSON.stringify({ documentId: input.documentId, decision: input.decision }),
      );
    return { id };
  });
}
