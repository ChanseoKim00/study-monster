import type { AttendanceStatus, RuleSettings, SessionTiming } from "./types.ts";

/**
 * 입/퇴장 측정값만으로 출결 상태를 판정한다 (사유는 고려하지 않음).
 *
 * 판정 매트릭스 (기획서 3.1 — 추정치이며 운영하며 조정 가능):
 *   미입장                         → ABSENT
 *   5분 이내 입장 + 95% 이상 체류  → PRESENT
 *   5분 이내 입장 + 95% 미만 체류  → ABSENT (시간 맞춰 왔어도 충분히 머물지 않음)
 *   5분 초과 입장 + 95% 이상 체류  → LATE
 *   5분 초과 입장 + 95% 미만 체류  → ABSENT (둘 다 미달 → 더 무거운 결석)
 */
export function judgeAttendance(
  timing: SessionTiming,
  settings: RuleSettings,
): AttendanceStatus {
  if (!timing.joined) return "ABSENT";

  const onTime = timing.minutesAfterStart <= settings.lateGraceMinutes;
  const stayedEnough = timing.attendanceRatio >= settings.minAttendanceRatio;

  if (!stayedEnough) return "ABSENT";
  return onTime ? "PRESENT" : "LATE";
}
