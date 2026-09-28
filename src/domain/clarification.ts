import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, dateOnly, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";
import { appendEvent, getRequestOrThrow, touchRequest } from "./store.ts";
import { addWorkdays } from "./calendar.ts";

export class ClarificationService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  /** 范围不清时请求补正：发出即暂停期限，记录补正截止日（默认 7 个工作日）。 */
  issue(requestId: string, question: string, workdays = 7, occurredAt?: string) {
    if (!question.trim()) throw Errors.validation("question 不能为空");
    return withTransaction(this.db, () => {
      const req = getRequestOrThrow(this.db, requestId);
      if (["answered", "closed", "changed"].includes(req.status)) {
        throw Errors.state("REQUEST_ALREADY_ANSWERED", "申请已答复，不能再要求补正");
      }
      const now = occurredAt ?? toIso(this.clock.now());
      const dueOn = addWorkdays(dateOnly(now), workdays);
      const id = newId("clr");
      this.db
        .prepare(
          `INSERT INTO clarification(id,request_id,issued_at,due_on,question,status)
           VALUES(?,?,?,?,?,'pending')`
        )
        .run(id, requestId, now, dueOn, question);
      appendEvent(this.db, requestId, "clarification_issued", this.clock, { id, dueOn, question }, "officer", now);
      appendEvent(this.db, requestId, "pause", this.clock, { reason: "clarification" }, "officer", now);
      touchRequest(this.db, requestId, "clarification_needed", this.clock);
      return { id, dueOn };
    });
  }

  /** 申请人回复补正：恢复期限。不能把逾期自动归咎申请人——只有显式恢复后才继续计时。 */
  respond(clarificationId: string, responseText: string, occurredAt?: string) {
    if (!responseText.trim()) throw Errors.validation("responseText 不能为空");
    return withTransaction(this.db, () => {
      const clr = this.db.prepare("SELECT * FROM clarification WHERE id = ?").get(clarificationId) as
        | { id: string; request_id: string; status: string }
        | undefined;
      if (!clr) throw Errors.notFound(`补正 ${clarificationId}`);
      if (clr.status !== "pending") {
        return { duplicated: true as const, id: clr.id, status: clr.status };
      }
      const now = occurredAt ?? toIso(this.clock.now());
      this.db
        .prepare("UPDATE clarification SET status='responded', response_at=?, response_text=? WHERE id=?")
        .run(now, responseText, clr.id);
      this.db
        .prepare("UPDATE foi_request SET scope_summary = COALESCE(NULLIF(scope_summary,''), ?), updated_at=?, version=version+1 WHERE id=?")
        .run(responseText, toIso(this.clock.now()), clr.request_id);
      appendEvent(this.db, clr.request_id, "clarification_responded", this.clock, { id: clr.id }, "applicant", now);
      appendEvent(this.db, clr.request_id, "resume", this.clock, { reason: "clarification_done" }, "applicant", now);
      touchRequest(this.db, clr.request_id, "under_review", this.clock);
      return { duplicated: false as const, id: clr.id, status: "responded" };
    });
  }

  listForRequest(requestId: string) {
    return this.db.prepare("SELECT * FROM clarification WHERE request_id = ? ORDER BY issued_at").all(requestId);
  }
}

/** 通用暂停/恢复（其他法定事由），与补正分开记录。 */
export function pauseRequest(db: DatabaseSync, clock: Clock, requestId: string, reason: string, at?: string) {
  return withTransaction(db, () => {
    getRequestOrThrow(db, requestId);
    return appendEvent(db, requestId, "pause", clock, { reason }, "officer", at);
  });
}

export function resumeRequest(db: DatabaseSync, clock: Clock, requestId: string, reason: string, at?: string) {
  return withTransaction(db, () => {
    getRequestOrThrow(db, requestId);
    return appendEvent(db, requestId, "resume", clock, { reason }, "officer", at);
  });
}
