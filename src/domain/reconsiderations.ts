import { tx } from "../db.ts";
import { ApiError } from "../errors.ts";
import { getRequest, requestView } from "./requests.ts";
import { createResponse, type ResponseItemInput } from "./responses.ts";
import { nowIso, type Ctx } from "./common.ts";

export function fileReconsideration(
  ctx: Ctx,
  requestId: string,
  input: { responseId: string; reason: string },
) {
  if (!input.reason) throw ApiError.validation("reason is required");
  return tx(ctx.db, () => {
    getRequest(ctx, requestId);
    const response = ctx.db
      .prepare("SELECT * FROM responses WHERE id = ? AND request_id = ?")
      .get(input.responseId, requestId) as { id: string } | undefined;
    if (!response) throw ApiError.notFound(`response ${input.responseId} for request ${requestId}`);
    const open = ctx.db
      .prepare("SELECT id FROM reconsiderations WHERE request_id = ? AND status = 'open'")
      .get(requestId);
    if (open) throw ApiError.conflict("an open reconsideration already exists for this request");
    const before = requestView(ctx, requestId);
    const id = ctx.idGen();
    ctx.db
      .prepare(
        "INSERT INTO reconsiderations(id, request_id, response_id, reason, status, created_at) VALUES (?,?,?,?, 'open', ?)",
      )
      .run(id, requestId, input.responseId, input.reason, nowIso(ctx));
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(ctx.idGen(), requestId, "reconsideration_filed", nowIso(ctx), JSON.stringify({ reconsiderationId: id }));
    return { id, before, after: requestView(ctx, requestId) };
  });
}

export function decideReconsideration(
  ctx: Ctx,
  reconsiderationId: string,
  input: {
    decision: "uphold" | "change";
    decisionText: string;
    newResponse?: { summary: string; items: ResponseItemInput[] };
  },
) {
  if (input.decision !== "uphold" && input.decision !== "change")
    throw ApiError.validation("decision must be 'uphold' or 'change'");
  if (!input.decisionText) throw ApiError.validation("decisionText is required");
  if (input.decision === "change" && !input.newResponse)
    throw ApiError.validation("newResponse is required when decision is 'change'");
  return tx(ctx.db, () => {
    const rec = ctx.db
      .prepare("SELECT * FROM reconsiderations WHERE id = ?")
      .get(reconsiderationId) as
      | { id: string; request_id: string; response_id: string; status: string }
      | undefined;
    if (!rec) throw ApiError.notFound(`reconsideration ${reconsiderationId}`);
    if (rec.status !== "open") throw ApiError.state(`reconsideration already ${rec.status}`);

    let newResponseId: string | null = null;
    if (input.decision === "change") {
      const created = createResponse(ctx, rec.request_id, input.newResponse!);
      newResponseId = created.id;
      ctx.db
        .prepare("UPDATE responses SET superseded_by = ? WHERE id = ?")
        .run(newResponseId, rec.response_id);
    }
    ctx.db
      .prepare(
        "UPDATE reconsiderations SET status = 'decided', decision = ?, decision_text = ?, new_response_id = ?, decided_at = ? WHERE id = ?",
      )
      .run(input.decision, input.decisionText, newResponseId, nowIso(ctx), reconsiderationId);
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(
        ctx.idGen(),
        rec.request_id,
        "reconsideration_decided",
        nowIso(ctx),
        JSON.stringify({ reconsiderationId, decision: input.decision, newResponseId }),
      );
    return {
      id: reconsiderationId,
      decision: input.decision,
      newResponseId,
      after: requestView(ctx, rec.request_id),
    };
  });
}
