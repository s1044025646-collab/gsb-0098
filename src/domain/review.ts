import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";
import { appendEvent, getRequestOrThrow } from "./store.ts";

export type Disposition = "public" | "redacted" | "withheld";

export interface SegmentDecisionInput {
  catalogItemId: string;
  segmentId?: string; // 省略表示对“整份资料/无片段定义”的决定
  disposition: Disposition;
  legalBasis: string;
  reason: string;
  redaction?: { start: number; end: number };
}

export class ReviewService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  decide(requestId: string, reviewer: string, input: SegmentDecisionInput, occurredAt?: string) {
    if (!reviewer.trim()) throw Errors.validation("reviewer 不能为空");
    if (!input.legalBasis.trim() || !input.reason.trim()) {
      throw Errors.validation("legalBasis 与 reason 均不能为空");
    }
    return withTransaction(this.db, () => {
      getRequestOrThrow(this.db, requestId);
      const item = this.db.prepare("SELECT id FROM catalog_item WHERE id = ?").get(input.catalogItemId);
      if (!item) throw Errors.validation(`资料 ${input.catalogItemId} 不存在`);
      let redactionStart: number | null = null;
      let redactionEnd: number | null = null;
      if (input.disposition === "redacted") {
        if (!input.redaction) throw Errors.validation("redacted 必须给出 redaction.start/end");
        const { start, end } = input.redaction;
        if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || start < 0) {
          throw Errors.validation("删隐位置必须为 0 <= start < end 的整数");
        }
        if (input.segmentId) {
          const seg = this.db
            .prepare("SELECT start_offset, end_offset FROM item_segment WHERE id = ? AND catalog_item_id = ?")
            .get(input.segmentId, input.catalogItemId) as { start_offset: number; end_offset: number } | undefined;
          if (!seg) throw Errors.validation(`片段 ${input.segmentId} 不属于该资料`);
          if (start < 0 || end > seg.end_offset - seg.start_offset) {
            throw Errors.validation("删隐位置超出片段范围");
          }
        }
        redactionStart = start;
        redactionEnd = end;
      }
      // 同一申请+片段保留为最新一条决定（答复版本由 answer 表留痕，审查表仅记录当前审查结论）
      if (input.segmentId) {
        this.db.prepare("DELETE FROM review_decision WHERE request_id = ? AND segment_id = ?").run(
          requestId,
          input.segmentId
        );
      }
      const id = newId("rvw");
      const now = occurredAt ?? toIso(this.clock.now());
      this.db
        .prepare(
          `INSERT INTO review_decision
             (id,request_id,catalog_item_id,segment_id,disposition,legal_basis,reason,
              redaction_start,redaction_end,reviewer,decided_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          requestId,
          input.catalogItemId,
          input.segmentId ?? null,
          input.disposition,
          input.legalBasis,
          input.reason,
          redactionStart,
          redactionEnd,
          reviewer,
          now
        );
      return { id };
    });
  }

  listForRequest(requestId: string) {
    return this.db
      .prepare(
        `SELECT r.*, s.label AS segment_label, s.start_offset AS seg_start
         FROM review_decision r
         LEFT JOIN item_segment s ON s.id = r.segment_id
         WHERE r.request_id = ? ORDER BY r.catalog_item_id, r.segment_id`
      )
      .all(requestId);
  }
}

export interface CoverageGap {
  itemId: string;
  missingSegments: string[];
}

/**
 * 覆盖校验：检索命中的每份资料，其每个片段都必须有审查结论。
 * 若资料含 public 片段，则不允许整件 withheld（禁止一概拒绝）。
 */
export function checkCoverage(db: DatabaseSync, requestId: string): { ok: boolean; gaps: CoverageGap[] } {
  const items = db
    .prepare("SELECT DISTINCT catalog_item_id AS id FROM search_hit WHERE request_id = ?")
    .all(requestId) as { id: string }[];
  const gaps: CoverageGap[] = [];
  for (const item of items) {
    const segments = db
      .prepare("SELECT id, label FROM item_segment WHERE catalog_item_id = ? ORDER BY start_offset")
      .all(item.id) as { id: string; label: string }[];
    const decisions = db
      .prepare("SELECT segment_id, disposition FROM review_decision WHERE request_id = ? AND catalog_item_id = ?")
      .all(requestId, item.id) as { segment_id: string | null; disposition: Disposition }[];
    if (segments.length === 0) {
      if (!decisions.some((d) => d.segment_id === null)) gaps.push({ itemId: item.id, missingSegments: ["<整份资料>"] });
      continue;
    }
    const missing = segments
      .filter((s) => !decisions.some((d) => d.segment_id === s.id))
      .map((s) => s.label);
    if (missing.length) gaps.push({ itemId: item.id, missingSegments: missing });
  }
  return { ok: gaps.length === 0, gaps };
}

export function assertNoBlanketDenial(db: DatabaseSync, requestId: string): void {
  const items = db
    .prepare("SELECT DISTINCT catalog_item_id AS id FROM search_hit WHERE request_id = ?")
    .all(requestId) as { id: string }[];
  for (const item of items) {
    const rows = db
      .prepare(
        `SELECT s.id,
                (SELECT disposition FROM review_decision r WHERE r.request_id = ? AND r.segment_id = s.id) AS disp
         FROM item_segment s WHERE s.catalog_item_id = ?`
      )
      .all(requestId, item.id) as { id: string; disp: Disposition | null }[];
    const decided = rows.filter((r) => r.disp !== null);
    if (decided.length > 0 && decided.every((r) => r.disp === "withheld")) {
      throw Errors.state(
        "BLANKET_DENIAL_FORBIDDEN",
        `资料 ${item.id} 存在未标注 withheld 的片段空间或整份被拒；必须逐项给出依据，不得一概拒绝`
      );
    }
  }
}

export function logReviewStart(db: DatabaseSync, clock: Clock, requestId: string, reviewer: string, at?: string) {
  return withTransaction(db, () =>
    appendEvent(db, requestId, "review_started", clock, { reviewer }, reviewer, at)
  );
}
