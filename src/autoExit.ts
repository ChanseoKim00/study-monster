import type { RuleSettings } from "./types.ts";

/** 멤버의 현재 상태. 사람이 아니라 시스템이 자동으로 결정한다. */
export type MemberStatus = "ACTIVE" | "WARNED" | "EXITED";

/**
 * 연속 벌금 주 수에 따라 자동 퇴장 여부를 판정한다.
 * 사람이 내쫓는 사회적 부담을 시스템 규칙으로 대체하는 핵심 기능.
 *
 * 임계치는 전부 설정값(기본: 연속 3주 경고, 4주 퇴장)이며 추정치다.
 */
export function evaluateAutoExit(
  consecutiveFineWeeks: number,
  settings: RuleSettings,
): MemberStatus {
  if (consecutiveFineWeeks >= settings.autoExit.exitAfterConsecutiveFineWeeks) {
    return "EXITED";
  }
  if (consecutiveFineWeeks >= settings.autoExit.warnAfterConsecutiveFineWeeks) {
    return "WARNED";
  }
  return "ACTIVE";
}
