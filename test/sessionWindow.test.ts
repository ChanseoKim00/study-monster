import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS as S } from "../src/settings.ts";
import {
  buildSessionTiming,
  type PresenceEvent,
  type TimeWindow,
} from "../src/sessionWindow.ts";
import { judgeAttendance } from "../src/attendance.ts";
import { weekStartMonday, consecutiveFineWeeks } from "../src/weekly.ts";

// 그날 22:00~23:00 KST = 13:00~14:00 UTC
const WINDOW: TimeWindow = {
  start: new Date("2026-06-22T13:00:00Z"),
  end: new Date("2026-06-22T14:00:00Z"),
};

const at = (z: string) => new Date(z);

test("정시 입장 후 끝까지 체류(leave 없음) → PRESENT", () => {
  const events: PresenceEvent[] = [{ type: "join", at: at("2026-06-22T13:02:00Z") }];
  const t = buildSessionTiming(events, WINDOW);
  assert.ok(t.minutesAfterStart <= S.lateGraceMinutes);
  assert.ok(t.attendanceRatio >= 0.95);
  assert.equal(judgeAttendance(t, S), "PRESENT");
});

// 주의: 60분 세션에서 10분 지각 후 끝까지 머물러도 체류율은 50/60=83% 라
// 현재 매트릭스상 LATE 가 아니라 ABSENT 가 된다. (기획서 "지각/체류율" 충돌 지점)
// 이 동작이 의도와 맞는지 기획자 확인 대기 중 — 확정되면 이 테스트도 같이 바뀐다.
test("10분 늦게 입장 + 끝까지 체류 → (현재 규칙) ABSENT", () => {
  const events: PresenceEvent[] = [{ type: "join", at: at("2026-06-22T13:10:00Z") }];
  const t = buildSessionTiming(events, WINDOW);
  assert.equal(t.minutesAfterStart, 10);
  assert.ok(t.attendanceRatio < S.minAttendanceRatio);
  assert.equal(judgeAttendance(t, S), "ABSENT");
});

test("정시 입장했지만 절반만 체류 → ABSENT(체류율 미달)", () => {
  const events: PresenceEvent[] = [
    { type: "join", at: at("2026-06-22T13:00:00Z") },
    { type: "leave", at: at("2026-06-22T13:30:00Z") },
  ];
  const t = buildSessionTiming(events, WINDOW);
  assert.equal(t.attendanceRatio, 0.5);
  assert.equal(judgeAttendance(t, S), "ABSENT");
});

test("재접속(여러 join/leave) 체류 시간 합산", () => {
  const events: PresenceEvent[] = [
    { type: "join", at: at("2026-06-22T13:00:00Z") },
    { type: "leave", at: at("2026-06-22T13:40:00Z") }, // 40분
    { type: "join", at: at("2026-06-22T13:45:00Z") },
    { type: "leave", at: at("2026-06-22T14:00:00Z") }, // +15분 = 55분
  ];
  const t = buildSessionTiming(events, WINDOW);
  assert.ok(Math.abs(t.attendanceRatio - 55 / 60) < 1e-9);
});

test("구간 밖 입/퇴장은 클램프된다", () => {
  const events: PresenceEvent[] = [
    { type: "join", at: at("2026-06-22T12:50:00Z") }, // 시작 10분 전
    { type: "leave", at: at("2026-06-22T14:30:00Z") }, // 종료 30분 후
  ];
  const t = buildSessionTiming(events, WINDOW);
  assert.equal(t.attendanceRatio, 1); // 구간 전체 체류
  assert.ok(t.minutesAfterStart < 0); // 시작 전 입장
  assert.equal(judgeAttendance(t, S), "PRESENT");
});

test("미입장(이벤트 없음) → ABSENT", () => {
  const t = buildSessionTiming([], WINDOW);
  assert.equal(t.joined, false);
  assert.equal(judgeAttendance(t, S), "ABSENT");
});

test("월요일 주 버킷 키(KST) — 같은 주의 다른 요일은 같은 키", () => {
  // 2026-06-22 는 월요일
  const monday = weekStartMonday(at("2026-06-22T13:00:00Z"));
  const thursday = weekStartMonday(at("2026-06-25T13:00:00Z"));
  const nextMon = weekStartMonday(at("2026-06-29T13:00:00Z"));
  assert.equal(monday, "2026-06-22");
  assert.equal(thursday, "2026-06-22");
  assert.equal(nextMon, "2026-06-29");
});

test("KST 자정 직전은 아직 같은 날(주) — 타임존 경계", () => {
  // 2026-06-22 23:59 KST = 14:59 UTC. UTC만 봤다면 22일이지만, 주 키는 동일해야 한다.
  const late = weekStartMonday(at("2026-06-22T14:59:00Z"));
  assert.equal(late, "2026-06-22");
});

test("연속 벌금 주 카운트 — 가장 최근부터 이어진 run", () => {
  assert.equal(consecutiveFineWeeks([true, false, true, true, true, true]), 4);
  assert.equal(consecutiveFineWeeks([true, true, false]), 0);
  assert.equal(consecutiveFineWeeks([]), 0);
});
