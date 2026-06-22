import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS as S } from "../src/settings.ts";
import {
  buildSessionTiming,
  type PresenceEvent,
  type TimeWindow,
} from "../src/sessionWindow.ts";
import { evaluateSession } from "../src/warnings.ts";
import { computeWeeklyFine } from "../src/fines.ts";
import { consecutiveFineWeeks } from "../src/weekly.ts";
import { evaluateAutoExit } from "../src/autoExit.ts";

// 원시 화상 이벤트 → 출결 → 경고 → 주간 벌금 → 자동 퇴장 전체 파이프라인 검증.

function windowFor(dayUtc: string): TimeWindow {
  return {
    start: new Date(`${dayUtc}T13:00:00Z`), // 22:00 KST
    end: new Date(`${dayUtc}T14:00:00Z`), // 23:00 KST
  };
}

/** 한 주(월~금 5세션) 전부 무단 결석한 멤버의 주간 벌금 = 부과. */
function fineForAllAbsentWeek(): boolean {
  const days = [
    "2026-06-22",
    "2026-06-23",
    "2026-06-24",
    "2026-06-25",
    "2026-06-26",
  ];
  const results = days.map((d) => {
    const noEvents: PresenceEvent[] = [];
    const timing = buildSessionTiming(noEvents, windowFor(d));
    return evaluateSession({ timing, reason: "NONE" }, S);
  });
  return computeWeeklyFine(results, S).fine > 0;
}

test("원시 이벤트 → 자동 퇴장까지: 4주 연속 전결 → EXITED", () => {
  // 4주 모두 벌금 부과되었다고 가정(동일 패턴).
  const finedWeeks = [
    fineForAllAbsentWeek(),
    fineForAllAbsentWeek(),
    fineForAllAbsentWeek(),
    fineForAllAbsentWeek(),
  ];
  assert.deepEqual(finedWeeks, [true, true, true, true]);

  const streak = consecutiveFineWeeks(finedWeeks);
  assert.equal(streak, 4);
  assert.equal(evaluateAutoExit(streak, S), "EXITED");
});

test("한 주 정상 참여가 끼면 연속 끊겨 ACTIVE", () => {
  const finedWeeks = [true, true, false, true]; // 3주차 정상
  const streak = consecutiveFineWeeks(finedWeeks);
  assert.equal(streak, 1);
  assert.equal(evaluateAutoExit(streak, S), "ACTIVE");
});
