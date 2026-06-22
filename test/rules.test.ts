import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS as S } from "../src/settings.ts";
import { evaluateSession } from "../src/warnings.ts";
import { computeWeeklyFine, computeSettlement } from "../src/fines.ts";
import { evaluateAutoExit } from "../src/autoExit.ts";
import type { SessionInput } from "../src/types.ts";

// 기획서 7번 "핵심 로직 검증" 10개 케이스를 그대로 검증 기준으로 사용한다.

// 1) 정시 입장(5분 이내) + 95% 이상 체류 → 정상 출석
test("정시 입장 + 95% 체류 → 정상 출석, 경고 0", () => {
  const r = evaluateSession(
    { timing: { joined: true, minutesAfterStart: 2, attendanceRatio: 0.98 }, reason: "NONE" },
    S,
  );
  assert.equal(r.status, "PRESENT");
  assert.equal(r.warningPoints, 0);
});

// 2) 10분 지각 + 95% 이상 체류 → 지각, 경고 0.5점
test("10분 지각 + 95% 체류 → 지각, 경고 0.5", () => {
  const r = evaluateSession(
    { timing: { joined: true, minutesAfterStart: 10, attendanceRatio: 0.97 }, reason: "NONE" },
    S,
  );
  assert.equal(r.status, "LATE");
  assert.equal(r.warningPoints, 0.5);
});

// 3) 미입장 → 결석, 경고 1.0점
test("미입장 → 결석, 경고 1.0", () => {
  const r = evaluateSession(
    { timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 }, reason: "NONE" },
    S,
  );
  assert.equal(r.status, "ABSENT");
  assert.equal(r.warningPoints, 1.0);
});

// 4) 야근 사유 신고 → 정당한 사유, 경고 0점
test("야근 사유 → 정당, 경고 0", () => {
  const r = evaluateSession(
    { timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 }, reason: "OVERTIME" },
    S,
  );
  assert.equal(r.warningPoints, 0);
  assert.equal(r.excused, true);
});

// 5) 애매한 개인사정 신고 → 무단 처리, 경고 1.0점
test("애매한 개인사정 결석 → 무단, 경고 1.0", () => {
  const r = evaluateSession(
    { timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 }, reason: "VAGUE_PERSONAL" },
    S,
  );
  assert.equal(r.warningPoints, 1.0);
  assert.equal(r.isVaguePersonalAbsence, true);
  assert.equal(r.otherWarningPoints, 0);
});

// 6) 정상 출석 + 분위기 저해 신고 → 경고 0.5점 (출석이어도 가산)
test("정상 출석 + 분위기저해 신고 → 경고 0.5 가산", () => {
  const r = evaluateSession(
    {
      timing: { joined: true, minutesAfterStart: 1, attendanceRatio: 0.99 },
      reason: "NONE",
      disturbanceReports: 3, // 세션당 1회 상한 → 0.5만 가산
    },
    S,
  );
  assert.equal(r.status, "PRESENT");
  assert.equal(r.warningPoints, 0.5);
  assert.equal(r.otherWarningPoints, 0.5);
});

// 7) 개인사정 결석만 주 2회 → 벌금 면제
test("개인사정 결석만 주 2회 → 벌금 면제", () => {
  const absent: SessionInput = {
    timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 },
    reason: "VAGUE_PERSONAL",
  };
  const week = [evaluateSession(absent, S), evaluateSession(absent, S)];
  const f = computeWeeklyFine(week, S);
  assert.equal(f.totalPoints, 2.0);
  assert.equal(f.reachedThreshold, true);
  assert.equal(f.exempted, true);
  assert.equal(f.fine, 0);
});

// 7-b) 개인사정 1회 + 무단지각 1회로 섞여 2점 → "섞이면 부과" (면제 안 됨)
test("개인사정 + 무단지각 섞여 임계치 → 정상 부과", () => {
  const vagueAbsent = evaluateSession(
    { timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 }, reason: "VAGUE_PERSONAL" },
    S,
  );
  const late = evaluateSession(
    { timing: { joined: true, minutesAfterStart: 10, attendanceRatio: 0.97 }, reason: "NONE" },
    S,
  );
  // 1.0(개인사정) + 0.5(지각) = 1.5 → 임계치 미달이므로 결석 1회 더해 2.0 만든다
  const late2 = evaluateSession(
    { timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 }, reason: "NONE" },
    S,
  );
  const f = computeWeeklyFine([vagueAbsent, late, late2], S);
  assert.ok(f.totalPoints >= S.fineThreshold);
  assert.equal(f.exempted, false);
  assert.equal(f.fine, S.fineAmount);
});

// 8) 무단 지각/결석으로 주간 경고 2점 누적 → 벌금 부과
test("무단 결석 2회로 2점 누적 → 벌금 부과", () => {
  const absent: SessionInput = {
    timing: { joined: false, minutesAfterStart: 0, attendanceRatio: 0 },
    reason: "NONE",
  };
  const week = [evaluateSession(absent, S), evaluateSession(absent, S)];
  const f = computeWeeklyFine(week, S);
  assert.equal(f.totalPoints, 2.0);
  assert.equal(f.exempted, false);
  assert.equal(f.fine, 5000);
});

// 9) 벌금 15,000원 / 참가자 4명 → 1인당 환급 3,750원
test("벌금 15000 / 4명 → 1인당 3750", () => {
  const s = computeSettlement(15000, 4);
  assert.equal(s.perPerson, 3750);
  assert.equal(s.remainder, 0);
});

// 10) 연속 4주 벌금 대상 → 자동 퇴장
test("연속 4주 벌금 → 자동 퇴장 (EXITED)", () => {
  assert.equal(evaluateAutoExit(4, S), "EXITED");
  assert.equal(evaluateAutoExit(3, S), "WARNED");
  assert.equal(evaluateAutoExit(2, S), "ACTIVE");
});
