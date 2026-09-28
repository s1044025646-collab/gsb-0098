import type { DatabaseSync } from "node:sqlite";
import { newId, sha256 } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";

export interface SubmitRequestInput {
  agencyId: string;
  applicantId: string;
  channelId: string;
  content: string;
  scopeSummary?: string;
  idempotencyKey?: string;
  receivedAt?: string; // 测试/补录可指定
}

export interface RequestRow {
  id: string;
  agency_id: string;
  applicant_id: string;
  channel_id: string;
  idempotency_key: string | null;
  content: string;
  content_hash: string;
  scope_summary: string;
  status: string;
  received_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Errors.validation(`${field} 不能为空`);
  }
  return value.trim();
}

/** 在同一事务内追加时间线事件并维护 seq。 */
export function appendEvent(
  db: DatabaseSync,
  requestId: string,
  type: string,
  clock: Clock,
  payload: Record<string, unknown> = {},
  actor = "system",
  occurredAt?: string
): string {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq),0) AS s FROM timeline_event WHERE request_id = ?")
    .get(requestId) as { s: number };
  const id = newId("evt");
  db.prepare(
    `INSERT INTO timeline_event(id, request_id, seq, type, occurred_at, payload_json, actor)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, requestId, row.s + 1, type, occurredAt ?? toIso(clock.now()), JSON.stringify(payload), actor);
  return id;
}

export function getRequestOrThrow(db: DatabaseSync, id: string): RequestRow {
  const row = db.prepare("SELECT * FROM foi_request WHERE id = ?").get(id) as RequestRow | undefined;
  if (!row) throw Errors.notFound(`申请 ${id}`);
  return row;
}

export function touchRequest(db: DatabaseSync, id: string, status: string, clock: Clock): void {
  db.prepare("UPDATE foi_request SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(
    status,
    toIso(clock.now()),
    id
  );
}

export class RequestService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  submit(input: SubmitRequestInput): RequestRow {
    const content = requireNonEmpty(input.content, "content");
    const agencyId = requireNonEmpty(input.agencyId, "agencyId");
    const applicantId = requireNonEmpty(input.applicantId, "applicantId");
    const channelId = requireNonEmpty(input.channelId, "channelId");
    if (content.length > 10_000) throw Errors.validation("content 过长（上限 10000 字）");

    return withTransaction(this.db, () => {
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare("SELECT * FROM foi_request WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as RequestRow | undefined;
        if (existing) return existing;
      }
      for (const [table, id] of [
        ["agency", agencyId],
        ["applicant", applicantId],
        ["channel", channelId],
      ] as const) {
        const r = this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
        if (!r) throw Errors.validation(`引用的 ${table} 不存在: ${id}`);
      }
      const id = newId("req");
      const now = toIso(this.clock.now());
      const receivedAt = input.receivedAt ? new Date(input.receivedAt).toISOString() : now;
      this.db
        .prepare(
          `INSERT INTO foi_request
             (id, agency_id, applicant_id, channel_id, idempotency_key, content, content_hash,
              scope_summary, status, received_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?, 'received', ?, ?, ?)`
        )
        .run(
          id,
          agencyId,
          applicantId,
          channelId,
          input.idempotencyKey ?? null,
          content,
          sha256(content),
          input.scopeSummary?.trim() ?? "",
          receivedAt,
          now,
          now
        );
      appendEvent(this.db, id, "received", this.clock, { channelId }, "applicant", receivedAt);
      return getRequestOrThrow(this.db, id);
    });
  }

  /** 分页查询申请，按收件时间倒序。 */
  list(opts: { limit?: number; offset?: number; status?: string; applicantId?: string } = {}): {
    items: RequestRow[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = Math.min(Math.max(Number(opts.limit ?? 20), 1), 100);
    const offset = Math.max(Number(opts.offset ?? 0), 0);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.applicantId) {
      where.push("applicant_id = ?");
      params.push(opts.applicantId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM foi_request ${clause}`).get(...params) as { c: number }).c;
    const items = this.db
      .prepare(`SELECT * FROM foi_request ${clause} ORDER BY received_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RequestRow[];
    return { items, total, limit, offset };
  }
}
