import type { Db } from "../db.ts";

export const BASE_WORKDAYS = 15;

export function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function loadHolidays(db: Db): Set<string> {
  const rows = db.prepare("SELECT day FROM holidays").all() as { day: string }[];
  return new Set(rows.map((r) => r.day));
}

export function isWorkday(d: Date, holidays: Set<string>): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(dayKey(d));
}

export function addWorkdays(start: Date, days: number, holidays: Set<string>): Date {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkday(d, holidays)) remaining--;
  }
  return d;
}

export function workdaysBetween(from: Date, to: Date, holidays: Set<string>): number {
  const a = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const b = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  if (b <= a) return 0;
  let count = 0;
  const d = new Date(a);
  while (d < b) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkday(d, holidays)) count++;
  }
  return count;
}

interface EventRow {
  type: string;
  at: string;
  payload: string | null;
}

/**
 * 期限 = 收件日 + (基础工作日 + 暂停占用工作日 + 延期工作日)。
 * 暂停/恢复来自明确事件（补正请求 -> 收到补正），不自动归因于申请人。
 */
export function computeDueAt(db: Db, requestId: string, receivedAt: Date): Date {
  const holidays = loadHolidays(db);
  const events = db
    .prepare(
      "SELECT type, at, payload FROM request_events WHERE request_id = ? AND type IN ('correction_requested','correction_received','extension_approved') ORDER BY at, rowid",
    )
    .all(requestId) as unknown as EventRow[];

  let pausedWorkdays = 0;
  let extraDays = 0;
  let pauseStart: Date | null = null;
  for (const ev of events) {
    if (ev.type === "correction_requested") {
      if (!pauseStart) pauseStart = new Date(ev.at);
    } else if (ev.type === "correction_received") {
      if (pauseStart) {
        pausedWorkdays += workdaysBetween(pauseStart, new Date(ev.at), holidays);
        pauseStart = null;
      }
    } else if (ev.type === "extension_approved") {
      const days = JSON.parse(ev.payload ?? "{}").days;
      if (typeof days === "number") extraDays += days;
    }
  }
  return addWorkdays(receivedAt, BASE_WORKDAYS + pausedWorkdays + extraDays, holidays);
}
