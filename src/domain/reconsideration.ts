import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";
import { appendEvent, getRequestOrThrow, touchRequest } from "./store.ts";

export class ReconsiderationService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  file(requestId: string, reason: string, idempotencyKey?: string, occurredAt?: string) {
    if (!reason.trim()) throw Errors.validation("复议理由不能为空");
    return withTransaction(this.db, () => {
      const req = getRequestOrThrow(this.db, requestId);
      if (idempotencyKey) {
        const existed = this.db
          .prepare("SELECT * FROM reconsideration WHERE idempotency_key = ?")
          .get(idempotencyKey) as Record<string, unknown> | undefined;
        if (existed) return { duplicated: true as const, reconsideration: existed };
      }
      const original = this.db
        .prepare("SELECT * FROM answer WHERE request_id = ? ORDER BY version DESC LIMIT 1")
        .get(requestId) as { id: string; kind: string } | undefined;
      if (!original) throw Errors.state("NO_ANSWER", "尚无正式答复，不能提起复议");
      const id = newId("rec");
      const now = occurredAt ?? toIso(this.clock.now());
      this.db
        .prepare(
          `INSERT INTO reconsideration(id,request_id,original_answer_id,idempotency_key,reason,filed_at,status)
           VALUES(?,?,?,?,?,?,'filed')`
        )
        .run(id, requestId, original.id, idempotencyKey ?? null, reason, now);
      appendEvent(this.db, requestId, "reconsideration_filed", this.clock, { id, originalAnswerId: original.id }, "applicant", now);
      touchRequest(this.db, requestId, "reconsideration_open", this.clock);
      return { duplicated: false as const, id, originalAnswerId: original.id };
    });
  }

  accept(reconsiderationId: string, occurredAt?: string) {
    return withTransaction(this.db, () => {
      const rec = this.getRow(reconsiderationId);
      if (rec.status !== "filed") return { duplicated: true as const, status: rec.status };
      const now = occurredAt ?? toIso(this.clock.now());
      this.db.prepare("UPDATE reconsideration SET status='accepted', accepted_at=? WHERE id=?").run(now, rec.id);
      appendEvent(this.db, rec.request_id, "reconsideration_accepted", this.clock, { id: rec.id }, "review_board", now);
      return { duplicated: false as const, status: "accepted" };
    });
  }

  /**
   * 复议决定：
   * - upheld：保留原答复，不改数据；
   * - changed：生成 kind='reconsideration' 的新答复版本（supersedes 原答复），
   *   新答复需引用现行 review_decision（调用方应先调整审查结论）。
   */
  decide(
    reconsiderationId: string,
    result: "upheld" | "changed",
    body: string,
    decidedBy: string,
    occurredAt?: string
  ) {
    if (!body.trim() || !decidedBy.trim()) throw Errors.validation("body 与 decidedBy 均不能为空");
    return withTransaction(this.db, () => {
      const rec = this.getRow(reconsiderationId);
      if (rec.status === "decided") return { duplicated: true as const, result: rec.result };
      if (rec.status !== "accepted") throw Errors.state("NOT_ACCEPTED", "复议须先受理再决定");
      const now = occurredAt ?? toIso(this.clock.now());

      let newAnswerId: string | null = null;
      if (result === "changed") {
        const original = this.db.prepare("SELECT * FROM answer WHERE id = ?").get(rec.original_answer_id) as {
          request_id: string;
          version: number;
        };
        const versionRow = this.db
          .prepare("SELECT COALESCE(MAX(version),0) AS v FROM answer WHERE request_id = ?")
          .get(rec.request_id) as { v: number };
        newAnswerId = newId("ans");
        this.db
          .prepare(
            `INSERT INTO answer(id,request_id,version,supersedes_id,kind,outcome,body,issued_at,issued_by)
             VALUES(?,?,?,?, 'reconsideration', ?, ?, ?, ?)`
          )
          .run(newAnswerId, rec.request_id, versionRow.v + 1, rec.original_answer_id, "partial", body, now, decidedBy);
        // 依据当前审查结论逐项生成新答复条目
        const decisions = this.db
          .prepare(
            `SELECT catalog_item_id AS item, disposition, legal_basis AS basis, reason,
                    redaction_start AS rs, redaction_end AS re
             FROM review_decision WHERE request_id = ? ORDER BY catalog_item_id, segment_id`
          )
          .all(rec.request_id) as {
            item: string;
            disposition: string;
            basis: string;
            reason: string;
            rs: number | null;
            re: number | null;
          }[];
        for (const d of decisions) {
          this.db
            .prepare(
              `INSERT INTO answer_item(id,answer_id,catalog_item_id,disposition,legal_basis,reason,redaction_start,redaction_end,public_text)
               VALUES(?,?,?,?,?,?,?,?, '')`
            )
            .run(newId("ait"), newAnswerId, d.item, d.disposition, d.basis, d.reason, d.rs, d.re);
        }
        appendEvent(
          this.db,
          rec.request_id,
          "reconsideration_decision",
          this.clock,
          { id: rec.id, result, newAnswerId },
          decidedBy,
          now
        );
        touchRequest(this.db, rec.request_id, "changed", this.clock);
      } else {
        appendEvent(
          this.db,
          rec.request_id,
          "reconsideration_decision",
          this.clock,
          { id: rec.id, result, originalAnswerId: rec.original_answer_id },
          decidedBy,
          now
        );
        touchRequest(this.db, rec.request_id, "answered", this.clock);
      }

      this.db
        .prepare("UPDATE reconsideration SET status='decided', decided_at=?, result=?, new_answer_id=? WHERE id=?")
        .run(now, result, newAnswerId, rec.id);
      return { duplicated: false as const, result, newAnswerId };
    });
  }

  private getRow(id: string) {
    const rec = this.db.prepare("SELECT * FROM reconsideration WHERE id = ?").get(id) as
      | {
          id: string;
          request_id: string;
          original_answer_id: string;
          status: "filed" | "accepted" | "decided" | "rejected";
          result: "upheld" | "changed" | null;
        }
      | undefined;
    if (!rec) throw Errors.notFound(`复议 ${id}`);
    return rec;
  }
}
