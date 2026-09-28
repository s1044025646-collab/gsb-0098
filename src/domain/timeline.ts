import { ApiError } from "../errors.ts";
import type { Ctx } from "./common.ts";

export function getTimeline(ctx: Ctx, requestId: string) {
  const request = ctx.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId);
  if (!request) throw ApiError.notFound(`request ${requestId}`);
  const events = ctx.db
    .prepare("SELECT type, at, payload FROM request_events WHERE request_id = ? ORDER BY at, rowid")
    .all(requestId) as { type: string; at: string; payload: string | null }[];
  return {
    request,
    events: events.map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null })),
  };
}
