import { tx } from "../db.ts";
import { ApiError } from "../errors.ts";
import { computeDueAt } from "./calendar.ts";
import { nowIso, type Ctx } from "./common.ts";

export const CHANNELS = ["online", "mail", "in_person"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface RequestRow {
  id: string;
  applicant_id: string;
  agency_id: string;
  channel: string;
  status: string;
  received_at: string;
  due_at: string | null;
  version: number;
}

export function getRequest(ctx: Ctx, id: string): RequestRow {
  const row = ctx.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as
    | RequestRow
    | undefined;
  if (!row) throw ApiError.notFound(`request ${id}`);
  return row;
}

export function requestView(ctx: Ctx, id: string) {
  const r = getRequest(ctx, id);
  const now = ctx.clock.now();
  const finalResponse = ctx.db
    .prepare("SELECT id FROM responses WHERE request_id = ? AND status = 'final'")
    .get(id);
  const overdue =
    r.due_at !== null && !finalResponse && now.getTime() > new Date(r.due_at).getTime();
  return { ...r, overdue };
}

function recordEvent(
  ctx: Ctx,
  requestId: string,
  type: string,
  payload: unknown,
  at?: string,
): void {
  ctx.db
    .prepare("INSERT INTO request_events(id, request_id, type, at, payload) VALUES (?,?,?,?,?)")
    .run(ctx.idGen(), requestId, type, at ?? nowIso(ctx), JSON.stringify(payload ?? null));
}

function refreshDueAt(ctx: Ctx, requestId: string): void {
  const r = getRequest(ctx, requestId);
  const due = computeDueAt(ctx.db, requestId, new Date(r.received_at));
  ctx.db
    .prepare("UPDATE requests SET due_at = ?, updated_at = ? WHERE id = ?")
    .run(due.toISOString(), nowIso(ctx), requestId);
}

export function createApplicant(ctx: Ctx, alias: string) {
  if (!alias || typeof alias !== "string") throw ApiError.validation("alias is required");
  const id = ctx.idGen();
  ctx.db
    .prepare("INSERT INTO applicants(id, alias, created_at) VALUES (?,?,?)")
    .run(id, alias, nowIso(ctx));
  return { id, alias };
}

export function submitRequest(
  ctx: Ctx,
  input: { applicantId: string; agencyId: string; scopeText: string; channel: string; idempotencyKey?: string },
) {
  if (!input.scopeText || typeof input.scopeText !== "string")
    throw ApiError.validation("scopeText is required");
  if (!CHANNELS.includes(input.channel as Channel))
    throw ApiError.validation(`channel must be one of ${CHANNELS.join(",")}`);
  const applicant = ctx.db.prepare("SELECT id FROM applicants WHERE id = ?").get(input.applicantId);
  if (!applicant) throw ApiError.notFound(`applicant ${input.applicantId}`);
  const agency = ctx.db.prepare("SELECT id FROM agencies WHERE id = ?").get(input.agencyId);
  if (!agency) throw ApiError.notFound(`agency ${input.agencyId}`);

  if (input.idempotencyKey) {
    const dup = ctx.db
      .prepare(
        "SELECT request_id FROM request_events WHERE type = 'submitted' AND json_extract(payload, '$.idempotencyKey') = ?",
      )
      .get(input.idempotencyKey) as { request_id: string } | undefined;
    if (dup) return { ...requestView(ctx, dup.request_id), idempotentReplay: true };
  }

  return tx(ctx.db, () => {
    const id = ctx.idGen();
    const now = nowIso(ctx);
    ctx.db
      .prepare(
        "INSERT INTO requests(id, applicant_id, agency_id, channel, status, received_at, version, created_at, updated_at) VALUES (?,?,?,?, 'received', ?, 1, ?, ?)",
      )
      .run(id, input.applicantId, input.agencyId, input.channel, now, now, now);
    ctx.db
      .prepare(
        "INSERT INTO request_versions(request_id, version, scope_text, channel, reason, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, 1, input.scopeText, input.channel, "initial submission", now);
    recordEvent(ctx, id, "submitted", {
      scopeText: input.scopeText,
      channel: input.channel,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    refreshDueAt(ctx, id);
    return { ...requestView(ctx, id), idempotentReplay: false };
  });
}

export function requestCorrection(ctx: Ctx, requestId: string, note: string) {
  if (!note) throw ApiError.validation("note is required");
  return tx(ctx.db, () => {
    const r = getRequest(ctx, requestId);
    if (["awaiting_correction", "responded", "closed"].includes(r.status))
      throw ApiError.state(`cannot request correction in status ${r.status}`);
    const before = requestView(ctx, requestId);
    recordEvent(ctx, requestId, "correction_requested", { note });
    ctx.db
      .prepare("UPDATE requests SET status = 'awaiting_correction', updated_at = ? WHERE id = ?")
      .run(nowIso(ctx), requestId);
    return { before, after: requestView(ctx, requestId) };
  });
}

export function receiveCorrection(ctx: Ctx, requestId: string, scopeText: string) {
  if (!scopeText) throw ApiError.validation("scopeText is required");
  return tx(ctx.db, () => {
    const r = getRequest(ctx, requestId);
    if (r.status !== "awaiting_correction")
      throw ApiError.state(`request is not awaiting correction (status=${r.status})`);
    const before = requestView(ctx, requestId);
    const newVersion = r.version + 1;
    ctx.db
      .prepare(
        "INSERT INTO request_versions(request_id, version, scope_text, channel, reason, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(requestId, newVersion, scopeText, r.channel, "correction", nowIso(ctx));
    ctx.db
      .prepare("UPDATE requests SET version = ?, status = 'received', updated_at = ? WHERE id = ?")
      .run(newVersion, nowIso(ctx), requestId);
    recordEvent(ctx, requestId, "correction_received", { scopeText, version: newVersion });
    refreshDueAt(ctx, requestId);
    return { before, after: requestView(ctx, requestId) };
  });
}

export function approveExtension(
  ctx: Ctx,
  requestId: string,
  input: { days: number; reason: string; approver: string },
) {
  if (!Number.isInteger(input.days) || input.days <= 0 || input.days > 30)
    throw ApiError.validation("days must be an integer between 1 and 30");
  if (!input.reason) throw ApiError.validation("reason is required");
  if (!input.approver) throw ApiError.validation("approver is required");
  return tx(ctx.db, () => {
    getRequest(ctx, requestId);
    const before = requestView(ctx, requestId);
    const id = ctx.idGen();
    ctx.db
      .prepare(
        "INSERT INTO extensions(id, request_id, days, reason, approver, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, requestId, input.days, input.reason, input.approver, nowIso(ctx));
    recordEvent(ctx, requestId, "extension_approved", {
      days: input.days,
      reason: input.reason,
      approver: input.approver,
    });
    refreshDueAt(ctx, requestId);
    return { id, before, after: requestView(ctx, requestId) };
  });
}

export function listRequestVersions(ctx: Ctx, requestId: string) {
  getRequest(ctx, requestId);
  return ctx.db
    .prepare("SELECT * FROM request_versions WHERE request_id = ? ORDER BY version")
    .all(requestId);
}
