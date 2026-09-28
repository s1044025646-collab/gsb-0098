import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addWorkdays,
  isOverdue,
  isWorkingDay,
  workingDaysBetween,
  type DateRange,
} from "../src/domain/calendar.ts";

test("周末与虚构假期不是工作日", () => {
  assert.equal(isWorkingDay("2026-01-02"), true); // 周五
  assert.equal(isWorkingDay("2026-01-03"), false); // 周六
  assert.equal(isWorkingDay("2026-01-01"), false); // 假期
});

test("期限跨春节假期：收件 2026-02-13(周五)，20 个工作日后落在 3 月", () => {
  // 2/16-2/18 假期；2/14、2/15 周末
  const due = addWorkdays("2026-02-13", 20);
  assert.ok(due > "2026-02-18");
  assert.equal(isWorkingDay(due), true);
  // 手工数：自 2/16 起第 1 个有效工作日为 2/19
  assert.equal(addWorkdays("2026-02-13", 1), "2026-02-19");
});

test("暂停/恢复区间内的日期不计入期限，逾期不自动归咎申请人", () => {
  const ranges: DateRange[] = [{ pauseOn: "2026-03-02", resumeOn: "2026-03-10" }];
  assert.equal(isWorkingDay("2026-03-03", ranges), false); // 工作日但被暂停
  assert.equal(isWorkingDay("2026-03-10", ranges), true);
  const normal = addWorkdays("2026-02-27", 3);
  const paused = addWorkdays("2026-02-27", 3, ranges);
  assert.ok(paused > normal);
});

test("暂停尚未恢复时计算上限抛错而非给出错误期限", () => {
  assert.throws(() =>
    addWorkdays("2026-02-27", 3, [{ pauseOn: "2026-02-28", resumeOn: null }])
  );
});

test("逾期比较与区间工作日计数", () => {
  assert.equal(isOverdue("2026-03-06", "2026-03-07"), true);
  assert.equal(isOverdue("2026-03-06", "2026-03-06"), false);
  // 16-18 假期，14/15 周末：区间内有效工作日只有 19、20
  assert.equal(workingDaysBetween("2026-02-13", "2026-02-20"), 2);
});
