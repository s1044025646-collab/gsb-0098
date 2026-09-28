/**
 * 工作日历：按 UTC 日期判断工作日；周末 + 显式假期（虚构，不连接真实节假日系统）。
 * 期限 = 从基准日的次日起，在“有效工作日”上推进 N 个工作日，
 * 暂停区间 [pauseOn, resumeOn) 内的日期一律跳过，因此逾期不会被自动归咎于申请人。
 */

export const FICTIONAL_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026 年虚构假期（演示用）
  "2026-01-01",
  "2026-02-16", "2026-02-17", "2026-02-18",
  "2026-04-06",
  "2026-05-01",
  "2026-06-19",
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
]);

export interface DateRange {
  pauseOn: string;
  resumeOn: string | null; // null 表示仍处于暂停
}

export function isWeekend(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isHoliday(day: string, holidays: ReadonlySet<string> = FICTIONAL_HOLIDAYS): boolean {
  return holidays.has(day);
}

export function isPaused(day: string, ranges: readonly DateRange[]): boolean {
  return ranges.some(
    (r) => r.pauseOn <= day && (r.resumeOn === null || day < r.resumeOn)
  );
}

export function isWorkingDay(
  day: string,
  ranges: readonly DateRange[] = [],
  holidays: ReadonlySet<string> = FICTIONAL_HOLIDAYS
): boolean {
  return !isWeekend(day) && !isHoliday(day, holidays) && !isPaused(day, ranges);
}

function addCalendarDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 从 fromDay 次日开始数 workdays 个有效工作日，返回截止日。
 * workdays=0 时返回 fromDay 之后第一个有效工作日。
 */
export function addWorkdays(
  fromDay: string,
  workdays: number,
  ranges: readonly DateRange[] = [],
  holidays: ReadonlySet<string> = FICTIONAL_HOLIDAYS
): string {
  if (workdays < 0) throw new Error("workdays must be >= 0");
  let cursor = addCalendarDays(fromDay, 1);
  let counted = 0;
  // 安全上限，避免暂停永不恢复造成死循环
  for (let guard = 0; guard < 100_000; guard++) {
    if (isWorkingDay(cursor, ranges, holidays)) {
      counted += 1;
      if (counted === workdays) return cursor;
    }
    cursor = addCalendarDays(cursor, 1);
  }
  throw new Error("deadline computation exceeded guard limit (pause never resumed?)");
}

/** 计算当前是否逾期（以 today 比较截止日）。 */
export function isOverdue(dueOn: string, today: string): boolean {
  return today > dueOn;
}

/** 剩余/超期工作日数（负号表示已超期的有效工作日数；暂停日不计为超期）。 */
export function workingDaysBetween(
  fromDay: string,
  toDay: string,
  ranges: readonly DateRange[] = [],
  holidays: ReadonlySet<string> = FICTIONAL_HOLIDAYS
): number {
  if (toDay < fromDay) return -workingDaysBetween(toDay, fromDay, ranges, holidays);
  let count = 0;
  let cursor = addCalendarDays(fromDay, 1);
  while (cursor <= toDay) {
    if (isWorkingDay(cursor, ranges, holidays)) count += 1;
    cursor = addCalendarDays(cursor, 1);
  }
  return count;
}
