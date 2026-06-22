import { judgeAttendance } from "./attendance.ts";
import type {
  ReasonCategory,
  RuleSettings,
  SessionInput,
  SessionResult,
} from "./types.ts";

/** 자동으로 정당 사유로 인정되는 카테고리(경고 면책). */
function isExcusedReason(
  reason: ReasonCategory,
  otherApproved: boolean,
): boolean {
  if (reason === "OVERTIME" || reason === "SELF_DEVELOPMENT") return true;
  // OTHER는 관리자 승인 시에만 정당. 승인 전엔 무단 취급.
  if (reason === "OTHER" && otherApproved) return true;
  return false;
}

/**
 * 한 세션의 출결 + 사유 + 분위기저해 신고를 종합해 경고 점수를 산출한다.
 *
 * 규칙:
 *   - 정당 사유(야근/자기개발/승인된 기타) → 출결 경고 0점.
 *   - PRESENT → 출결 경고 0점.
 *   - LATE(무단) → lateUnexcused (0.5).
 *   - ABSENT + 애매한 개인사정 → vagueAbsent (1.0).
 *   - ABSENT(그 외 무단) → absentUnexcused (1.0).
 *   - 분위기저해 신고 → 위 판정과 별도로 가산(세션당 상한 적용).
 */
export function evaluateSession(
  input: SessionInput,
  settings: RuleSettings,
): SessionResult {
  const status = judgeAttendance(input.timing, settings);
  const excused = isExcusedReason(input.reason, input.otherApproved ?? false);
  const isVaguePersonalAbsence =
    status === "ABSENT" && input.reason === "VAGUE_PERSONAL";

  let attendancePoints = 0;
  if (!excused) {
    if (status === "LATE") {
      attendancePoints = settings.weights.lateUnexcused;
    } else if (status === "ABSENT") {
      attendancePoints = isVaguePersonalAbsence
        ? settings.weights.vagueAbsent
        : settings.weights.absentUnexcused;
    }
  }

  const cappedDisturbance = Math.min(
    input.disturbanceReports ?? 0,
    settings.maxDisturbancePerSession,
  );
  const disturbancePoints = cappedDisturbance * settings.weights.disturbance;

  // 개인사정 외 사유로 발생한 점수 = 지각/무단결석 점수 + 분위기저해 점수.
  // (주간 벌금 면제 판단: "다른 사유가 섞였는가" 를 가린다)
  const otherWarningPoints =
    (isVaguePersonalAbsence ? 0 : attendancePoints) + disturbancePoints;

  return {
    status,
    excused: excused && status !== "PRESENT",
    warningPoints: attendancePoints + disturbancePoints,
    isVaguePersonalAbsence,
    otherWarningPoints,
  };
}
