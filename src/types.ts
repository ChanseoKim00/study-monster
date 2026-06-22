// 규칙 엔진의 도메인 타입.
// 이 코어는 화상 SDK / DB / UI 와 독립적이며, 순수 입력 → 판정 결과만 다룬다.

/** 출결 판정 결과 */
export type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

/**
 * 멤버가 신고한 사유 카테고리.
 * - OVERTIME / SELF_DEVELOPMENT: 자동 정당 (경고 없음)
 * - VAGUE_PERSONAL: 애매한 개인사정 → 무단 처리 (단 주 N회까지 벌금 면제)
 * - OTHER: 관리자 수동 승인 필요 (승인 전엔 무단 취급)
 * - NONE: 사유 미입력 (기본 무단)
 */
export type ReasonCategory =
  | "OVERTIME"
  | "SELF_DEVELOPMENT"
  | "VAGUE_PERSONAL"
  | "OTHER"
  | "NONE";

/** 한 세션에서 한 멤버의 입/퇴장 시간 측정값 */
export interface SessionTiming {
  /** 입장 여부. false면 미입장(완전 결석). */
  joined: boolean;
  /** 스터디 시작(22:00) 기준 입장까지 걸린 분. 정시·조기 입장이면 0 이하. */
  minutesAfterStart: number;
  /** 전체 학습 시간 대비 체류 비율 (0.0 ~ 1.0). */
  attendanceRatio: number;
}

/** 한 세션에서 한 멤버에 대한 원시 입력 (타이밍 + 신고 + 분위기저해 신고 수) */
export interface SessionInput {
  timing: SessionTiming;
  reason: ReasonCategory;
  /** OTHER 사유가 관리자에게 승인되었는지. OTHER 외 카테고리에선 무시됨. */
  otherApproved?: boolean;
  /** 이 세션에 들어온 분위기저해 신고 수 (어뷰징 방지로 세션당 상한 적용). */
  disturbanceReports?: number;
}

/** 한 세션 판정 결과 — 주간 집계가 이 값들을 합산한다. */
export interface SessionResult {
  status: AttendanceStatus;
  /** 정당 사유로 면책되었는지 (경고 0점이 사유 때문인지). */
  excused: boolean;
  /** 이 세션에서 부여된 총 경고 점수 (출결 + 분위기저해 가산 포함). */
  warningPoints: number;
  /** 애매한 개인사정 결석이었는지 (주간 면제 한도 집계용). */
  isVaguePersonalAbsence: boolean;
  /** 개인사정 외 사유(지각/무단결석/분위기저해)로 발생한 경고 점수. */
  otherWarningPoints: number;
}

/** 관리자가 조정 가능한 모든 기준값. 하드코딩 금지 — 전부 여기로 모은다. */
export interface RuleSettings {
  /** 이 분 이내 입장이면 지각 아님. (기본 5분) */
  lateGraceMinutes: number;
  /** 이 비율 이상 체류해야 출석 인정. (기본 0.95) */
  minAttendanceRatio: number;
  weights: {
    /** 무단 지각 */
    lateUnexcused: number;
    /** 무단 결석 */
    absentUnexcused: number;
    /** 애매한 개인사정 결석 (무단 결석과 동일 취급) */
    vagueAbsent: number;
    /** 분위기 저해 (다른 판정에 가산) */
    disturbance: number;
  };
  /** 세션당 분위기저해 가산 최대 횟수 (어뷰징 방지, 기본 1). */
  maxDisturbancePerSession: number;
  /** 이 점수 이상 누적 시 벌금 대상. (기본 2.0) */
  fineThreshold: number;
  /** 벌금 액수(원). (기본 5000) */
  fineAmount: number;
  /** 개인사정 결석을 주 몇 회까지 벌금 면제할지. (기본 2) */
  personalLeaveWeeklyExemptLimit: number;
  autoExit: {
    /** 연속 벌금 주가 이 수에 도달하면 경고 안내. (기본 3) */
    warnAfterConsecutiveFineWeeks: number;
    /** 연속 벌금 주가 이 수에 도달하면 자동 퇴장. (기본 4) */
    exitAfterConsecutiveFineWeeks: number;
  };
}
