import type { RuleSettings } from "./types.ts";

/**
 * 합리적 기본값. 기획서가 확정하지 못한 값(자동 퇴장 임계치 등)은
 * 추정치이며 운영하면서 조정 가능 — 전부 설정값으로 분리되어 있다.
 */
export const DEFAULT_SETTINGS: RuleSettings = {
  lateGraceMinutes: 5,
  minAttendanceRatio: 0.95,
  weights: {
    lateUnexcused: 0.5,
    absentUnexcused: 1.0,
    vagueAbsent: 1.0,
    disturbance: 0.5,
  },
  maxDisturbancePerSession: 1,
  fineThreshold: 2.0,
  fineAmount: 5000,
  personalLeaveWeeklyExemptLimit: 2,
  autoExit: {
    // 추정치: 기획서 6번에서 확정되지 않음. 운영하며 조정 가능.
    warnAfterConsecutiveFineWeeks: 3,
    exitAfterConsecutiveFineWeeks: 4,
  },
};
