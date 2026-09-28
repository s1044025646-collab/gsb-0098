import { tx } from "../db.ts";
import { ApiError } from "../errors.ts";
import { getRequest, requestView } from "./requests.ts";
import { nowIso, type Ctx } from "./common.ts";

export function assignSearchTask(ctx: Ctx, requestId: string, assignee: string) {
  if (!assignee) throw ApiError.validation("assignee is required");
  return tx(ctx.db, () => {
    const r = getRequest(ctx, requestId);
    if (r.status === "awaiting_correction")
      throw ApiError.state("request is awaiting correction; search cannot start");
    const before = requestView(ctx, requestId);
    const id = ctx.idGen();
    ctx.db
      .prepare(
        "INSERT INTO search_tasks(id, request_id, assignee, status, created_at) VALUES (?,?,?,'assigned',?)",
      )
      .run(id, requestId, assignee, nowIso(ctx));
    ctx.db
      .prepare("UPDATE requests SET status = 'searching', updated_at = ? WHERE id = ?")
      .run(nowIso(ctx), requestId);
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(ctx.idGen(), requestId, "search_assigned", nowIso(ctx), JSON.stringify({ assignee, taskId: id }));
    return { id, before, after: requestView(ctx, requestId) };
  });
}

export function completeSearchTask(ctx: Ctx, taskId: string, documentIds: string[]) {
  return tx(ctx.db, () => {
    const task = ctx.db.prepare("SELECT * FROM search_tasks WHERE id = ?").get(taskId) as
      | { id: string; request_id: string; status: string }
      | undefined;
    if (!task) throw ApiError.notFound(`search task ${taskId}`);
    if (task.status !== "assigned") throw ApiError.state(`task already ${task.status}`);
    for (const docId of documentIds) {
      const doc = ctx.db.prepare("SELECT id FROM documents WHERE id = ?").get(docId);
      if (!doc) throw ApiError.notFound(`document ${docId}`);
    }
    ctx.db
      .prepare("UPDATE search_tasks SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(nowIso(ctx), taskId);
    ctx.db
      .prepare("UPDATE requests SET status = 'reviewing', updated_at = ? WHERE id = ?")
      .run(nowIso(ctx), task.request_id);
    ctx.db
      .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(
        ctx.idGen(),
        task.request_id,
        "search_completed",
        nowIso(ctx),
        JSON.stringify({ taskId, documentIds }),
      );
    return { id: taskId, after: requestView(ctx, task.request_id) };
  });
}
