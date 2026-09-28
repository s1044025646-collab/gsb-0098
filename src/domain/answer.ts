import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";
import { appendEvent, getRequestOrThrow, touchRequest } from "./store.ts";
import { assertNoBlanketDenial, checkCoverage, type Disposition } from "./review.ts";

const REDACT_MARK = "█";

function applyRedaction(text: string, start: number | null, end: number | null): string {
  if (start === null || end === null) return text;
  return text.slice(0, start) + REDACT_MARK.repeat(Math.max(end - start, 1)) + text.slice(end);
}

export interface AnswerResult {
  answerId: string;
  version: number;
  outcome: "granted" | "partial" | "denied" | "no_record";
  items: unknown[];
}

export class AnswerService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * 生成正式答复（不可变）。命中资料逐项进入 answer_item，写明依据、理由与删隐位置；
   * 未命中任何资料 => no_record。
   */
  generate(requestId: string, issuedBy: string, body: string, occurredAt?: string): AnswerResult {
    if (!issuedBy.trim()) throw Errors.validation("issuedBy 不能为空");
    if (!body.trim()) throw Errors.validation("答复正文 body 不能为空");
    return withTransaction(this.db, () => {
      const req = getRequestOrThrow(this.db, requestId);
      if (req.status === "answered" || req.status === "closed") {
        throw Errors.state("ANSWER_IMMUTABLE", "已存在正式答复；变更必须通过复议生成新版本");
      }
      const hits = this.db
        .prepare("SELECT DISTINCT catalog_item_id AS id FROM search_hit WHERE request_id = ?")
        .all(requestId) as { id: string }[];

      let outcome: AnswerResult["outcome"];
      if (hits.length === 0) {
        outcome = "no_record";
      } else {
        const coverage = checkCoverage(this.db, requestId);
        if (!coverage.ok) {
          throw Errors.state("SEGMENT_COVERAGE_INCOMPLETE", "存在未审查片段", coverage.gaps);
        }
        assertNoBlanketDenial(this.db, requestId);
        const decisions = this.db
          .prepare("SELECT disposition FROM review_decision WHERE request_id = ?")
          .all(requestId) as { disposition: Disposition }[];
        outcome = decisions.every((d) => d.disposition === "public")
          ? "granted"
          : decisions.some((d) => d.disposition === "withheld" || d.disposition === "redacted")
            ? "partial"
            : "granted";
        if (decisions.every((d) => d.disposition === "withheld")) outcome = "denied";
      }

      const versionRow = this.db
        .prepare("SELECT COALESCE(MAX(version),0) AS v FROM answer WHERE request_id = ?")
        .get(requestId) as { v: number };
      const version = versionRow.v + 1;
      const answerId = newId("ans");
      const now = occurredAt ?? toIso(this.clock.now());
      this.db
        .prepare(
          `INSERT INTO answer(id,request_id,version,supersedes_id,kind,outcome,body,issued_at,issued_by)
           VALUES(?,?,?,NULL,'final',?,?,?,?)`
        )
        .run(answerId, requestId, version, outcome, body, now, issuedBy);

      const items: unknown[] = [];
      if (hits.length === 0) {
        // no_record 也逐项说明检索范围为空
      } else {
        for (const hit of hits) {
          const itemRows = this.db
            .prepare("SELECT id, title FROM catalog_item WHERE id = ?")
            .all(hit.id) as { id: string; title: string }[];
          const title = itemRows[0]?.title ?? hit.id;
          const segDecisions = this.db
            .prepare(
              `SELECT r.segment_id, r.disposition, r.legal_basis, r.reason,
                      r.redaction_start, r.redaction_end,
                      s.full_text, s.start_offset AS seg_start
               FROM review_decision r
               LEFT JOIN item_segment s ON s.id = r.segment_id
               WHERE r.request_id = ? AND r.catalog_item_id = ? ORDER BY s.start_offset`
            )
            .all(requestId, hit.id) as {
              segment_id: string | null;
              disposition: Disposition;
              legal_basis: string;
              reason: string;
              redaction_start: number | null;
              redaction_end: number | null;
              full_text: string | null;
              seg_start: number | null;
            }[];

          const allWithheld = segDecisions.length > 0 && segDecisions.every((d) => d.disposition === "withheld");
          const itemDisposition = allWithheld
            ? "withheld"
            : segDecisions.some((d) => d.disposition !== "public")
              ? "redacted"
              : "public";

          let publicText = "";
          const bases = new Set<string>();
          const reasons: string[] = [];
          let minStart: number | null = null;
          let maxEnd: number | null = null;
          for (const d of segDecisions) {
            bases.add(d.legal_basis);
            reasons.push(d.reason);
            if (d.disposition !== "withheld" && d.full_text !== null) {
              const segmentText =
                d.disposition === "redacted"
                  ? applyRedaction(d.full_text, d.redaction_start, d.redaction_end)
                  : d.full_text;
              publicText += segmentText;
            }
            if (d.disposition === "redacted" && d.seg_start !== null) {
              const absStart = d.seg_start + (d.redaction_start ?? 0);
              const absEnd = d.seg_start + (d.redaction_end ?? 0);
              minStart = minStart === null ? absStart : Math.min(minStart, absStart);
              maxEnd = maxEnd === null ? absEnd : Math.max(maxEnd, absEnd);
            }
          }
          const answerItemId = newId("ait");
          this.db
            .prepare(
              `INSERT INTO answer_item
                 (id,answer_id,catalog_item_id,disposition,legal_basis,reason,redaction_start,redaction_end,public_text)
               VALUES (?,?,?,?,?,?,?,?,?)`
            )
            .run(
              answerItemId,
              answerId,
              hit.id,
              itemDisposition,
              [...bases].join("；"),
              reasons.join("；"),
              minStart,
              maxEnd,
              publicText
            );
          items.push({ answerItemId, itemId: hit.id, title, disposition: itemDisposition, publicText });
        }
      }

      appendEvent(this.db, requestId, "answer_issued", this.clock, { answerId, version, outcome }, issuedBy, now);
      touchRequest(this.db, requestId, "answered", this.clock);
      return { answerId, version, outcome, items };
    });
  }

  /** 送达：幂等键重复时标记 duplicate，不重复计数。 */
  deliver(answerId: string, channelId: string, idempotencyKey: string, occurredAt?: string) {
    return withTransaction(this.db, () => {
      const ans = this.db.prepare("SELECT id, request_id FROM answer WHERE id = ?").get(answerId) as
        | { id: string; request_id: string }
        | undefined;
      if (!ans) throw Errors.notFound(`答复 ${answerId}`);
      const dup = this.db
        .prepare("SELECT * FROM delivery WHERE idempotency_key = ? AND status != 'failed'")
        .get(idempotencyKey) as { id: string; duplicate_of: string | null } | undefined;
      const attemptRow = this.db
        .prepare("SELECT COALESCE(MAX(attempt_no),0) AS n FROM delivery WHERE answer_id = ?")
        .get(answerId) as { n: number };
      const id = newId("dlv");
      const now = occurredAt ?? toIso(this.clock.now());
      if (dup) {
        this.db
          .prepare(
            `INSERT INTO delivery(id,answer_id,request_id,idempotency_key,channel_id,attempt_no,sent_at,duplicate_of,status)
             VALUES(?,?,?,?,?,?,?,?, 'duplicate')`
          )
          .run(id, answerId, ans.request_id, idempotencyKey, channelId, attemptRow.n, now, dup.id);
        appendEvent(this.db, ans.request_id, "redelivery", this.clock, { duplicateOf: dup.id }, "system", now);
        return { deliveryId: id, duplicated: true as const, duplicateOf: dup.id };
      }
      this.db
        .prepare(
          `INSERT INTO delivery(id,answer_id,request_id,idempotency_key,channel_id,attempt_no,sent_at,status)
           VALUES(?,?,?,?,?,?,?, 'delivered')`
        )
        .run(id, answerId, ans.request_id, idempotencyKey, channelId, attemptRow.n + 1, now);
      return { deliveryId: id, duplicated: false as const, attemptNo: attemptRow.n + 1 };
    });
  }

  get(id: string) {
    const answer = this.db.prepare("SELECT * FROM answer WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!answer) throw Errors.notFound(`答复 ${id}`);
    const items = this.db
      .prepare("SELECT * FROM answer_item WHERE answer_id = ? ORDER BY catalog_item_id")
      .all(id);
    return { ...answer, items };
  }
}
