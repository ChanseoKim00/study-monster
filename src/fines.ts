import type { RuleSettings, SessionResult } from "./types.ts";

export interface WeeklyFineResult {
  /** 이번 주 누적 경고 점수 합. */
  totalPoints: number;
  /** 애매한 개인사정 결석 횟수. */
  vaguePersonalCount: number;
  /** 개인사정 외 사유로 발생한 경고 점수 합. */
  otherWarningPoints: number;
  /** 임계치 도달 여부(면제 적용 전). */
  reachedThreshold: boolean;
  /** 개인사정 면제 규칙이 적용되어 벌금이 빠졌는지. */
  exempted: boolean;
  /** 최종 부과 벌금(원). 면제되면 0. */
  fine: number;
}

/**
 * 한 멤버의 한 주치 세션 결과들을 모아 벌금을 판정한다.
 *
 * 면제 규칙 (기획서 2.4, "섞이면 부과"로 확정):
 *   임계치(기본 2.0점)에 도달해도,
 *   - 애매한 개인사정 결석이 주 N회(기본 2회) 이내이고
 *   - 그 외 사유(무단지각/무단결석/분위기저해)로 인한 경고가 0점이면
 *   → 벌금 면제.
 *   개인사정에 다른 사유가 단 0.5점이라도 섞이면 정상 부과.
 */
export function computeWeeklyFine(
  sessions: SessionResult[],
  settings: RuleSettings,
): WeeklyFineResult {
  const totalPoints = sessions.reduce((s, r) => s + r.warningPoints, 0);
  const vaguePersonalCount = sessions.filter(
    (r) => r.isVaguePersonalAbsence,
  ).length;
  const otherWarningPoints = sessions.reduce(
    (s, r) => s + r.otherWarningPoints,
    0,
  );

  const reachedThreshold = totalPoints >= settings.fineThreshold;
  const exempted =
    reachedThreshold &&
    otherWarningPoints === 0 &&
    vaguePersonalCount <= settings.personalLeaveWeeklyExemptLimit;

  return {
    totalPoints,
    vaguePersonalCount,
    otherWarningPoints,
    reachedThreshold,
    exempted,
    fine: reachedThreshold && !exempted ? settings.fineAmount : 0,
  };
}

export interface SettlementResult {
  /** 정산 기간 모인 벌금 총액. */
  totalFines: number;
  /** 정산 대상 참가자 수. */
  participantCount: number;
  /** 1인당 환급액(원, 원 단위 내림). */
  perPerson: number;
  /** n분의1로 안 나눠떨어진 잔액(원). */
  remainder: number;
}

/**
 * 모인 벌금을 정산 기간 참가자 수로 n분의1 환급.
 * 개근한 사람도 1/n을 받으므로, 지각/결석자가 전원에게 보상을 나눠주는 구조.
 * 실제 송금은 범위 밖 — 1인당 금액 계산까지만.
 */
export function computeSettlement(
  totalFines: number,
  participantCount: number,
): SettlementResult {
  if (participantCount <= 0) {
    throw new Error("participantCount는 1 이상이어야 합니다.");
  }
  const perPerson = Math.floor(totalFines / participantCount);
  return {
    totalFines,
    participantCount,
    perPerson,
    remainder: totalFines - perPerson * participantCount,
  };
}
