import type { DatabaseSync } from "node:sqlite";
import { computeDeadline } from "./deadline.ts";

export interface TimelineEntry {
  seq: number;
  type: string;
  occurredAt: string;
  actor: string;
  payload: unknown;
}

export function exportTimeline(db: DatabaseSync, requestId: string, today?: string) {
  const req = db.prepare("SELECT * FROM foi_request WHERE id = ?").get(requestId) as
    | Record<string, unknown>
    | undefined;
  if (!req) return null;
  const events = db
    .prepare("SELECT seq, type, occurred_at, payload_json, actor FROM timeline_event WHERE request_id = ? ORDER BY seq")
    .all(requestId) as {
    seq: number;
    type: string;
    occurred_at: string;
    payload_json: string;
    actor: string;
  }[];
  const answers = db
    .prepare(
      `SELECT a.*, (SELECT json_group_array(json_object(
          'itemId', ai.catalog_item_id, 'disposition', ai.disposition,
          'legalBasis', ai.legal_basis, 'reason', ai.reason,
          'redactionStart', ai.redaction_start, 'redactionEnd', ai.redaction_end))
        FROM answer_item ai WHERE ai.answer_id = a.id) AS items
       FROM answer a WHERE a.request_id = ? ORDER BY a.version`
    )
    .all(requestId);
  const deliveries = db
    .prepare("SELECT * FROM delivery WHERE request_id = ? ORDER BY sent_at")
    .all(requestId);
  const reconsiderations = db
    .prepare("SELECT * FROM reconsideration WHERE request_id = ? ORDER BY filed_at")
    .all(requestId);
  const clarifications = db
    .prepare("SELECT * FROM clarification WHERE request_id = ? ORDER BY issued_at")
    .all(requestId);
  const extensions = db
    .prepare("SELECT * FROM extension WHERE request_id = ? ORDER BY requested_at")
    .all(requestId);

  const deadline = computeDeadline(db, requestId, today ? { today } : {});
  const timeline: TimelineEntry[] = events.map((e) => ({
    seq: e.seq,
    type: e.type,
    occurredAt: e.occurred_at,
    actor: e.actor,
    payload: JSON.parse(e.payload_json),
  }));

  return {
    request: req,
    deadline,
    timeline,
    clarifications,
    extensions,
    answers,
    deliveries,
    reconsiderations,
  };
}
