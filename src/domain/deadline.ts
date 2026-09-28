import type { DatabaseSync } from "node:sqlite";
import { addWorkdays, isOverdue, type DateRange } from "./calendar.ts";
import { dateOnly } from "./clock.ts";

export interface DeadlineInfo {
  receivedOn: string;
  baseWorkdays: number;
  extraWorkdays: number;
  pauseRanges: DateRange[];
  dueOn: string | null; // 暂停尚未恢复时为 null（期限未定)
  today: string;
  overdue: boolean;
  pausedNow: boolean;
}

export interface DeadlineOptions {
  baseWorkdays?: number;
  today?: string; // 注入业务日期，测试不依赖真实时间
}

/** 汇总暂停区间与已批准延期，计算当前答复期限。 */
export function computeDeadline(db: DatabaseSync, requestId: string, opts: DeadlineOptions = {}): DeadlineInfo {
  const req = db
    .prepare("SELECT received_at FROM foi_request WHERE id = ?")
    .get(requestId) as { received_at: string } | undefined;
  if (!req) throw new Error(`request ${requestId} not found`);

  const events = db
    .prepare("SELECT type, occurred_at, payload_json FROM timeline_event WHERE request_id = ? ORDER BY seq")
    .all(requestId) as { type: string; occurred_at: string }[];

  const pauseRanges: DateRange[] = [];
  const openPauses: { day: string; reason: string }[] = [];
  for (const ev of events) {
    const day = dateOnly(ev.occurred_at);
    if (ev.type === "pause") {
      let reason = "";
      try {
        reason = String(
          (JSON.parse((ev as unknown as { payload_json?: string }).payload_json ?? "{}") as { reason?: string })
            .reason ?? ""
        );
      } catch {
        reason = "";
      }
      openPauses.push({ day, reason });
    }
    if (ev.type === "resume") {
      const last = openPauses.pop();
      if (last) pauseRanges.push({ pauseOn: last.day, resumeOn: day });
    }
  }
  for (const p of openPauses) pauseRanges.push({ pauseOn: p.day, resumeOn: null });

  const ext = db
    .prepare(
      "SELECT COALESCE(SUM(extra_workdays),0) AS d FROM extension WHERE request_id = ? AND status = 'approved'"
    )
    .get(requestId) as { d: number };

  const baseWorkdays = opts.baseWorkdays ?? 20;
  const extraWorkdays = Number(ext.d);
  const receivedOn = dateOnly(req.received_at);
  const today = opts.today ?? dateOnly(new Date().toISOString());
  const pausedNow = pauseRanges.some((r) => r.pauseOn <= today && (r.resumeOn === null || today < r.resumeOn));
  const stillPaused = pauseRanges.some((r) => r.resumeOn === null);
  // 仍在暂停时无法确定截止日；仅对已闭合区间计算理论期限供参考
  const closedRanges = pauseRanges.filter((r) => r.resumeOn !== null);
  const dueOn = stillPaused ? null : addWorkdays(receivedOn, baseWorkdays + extraWorkdays, closedRanges);

  return {
    receivedOn,
    baseWorkdays,
    extraWorkdays,
    pauseRanges,
    dueOn,
    today,
    overdue: dueOn !== null ? isOverdue(dueOn, today) && !pausedNow : false,
    pausedNow,
  };
}
