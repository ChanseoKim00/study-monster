import type { RuleSettings } from "./types.ts";

export interface SettingsValidationResult {
  valid: boolean;
  /** 관리자에게 그대로 보여줄 한국어 에러 메시지들. valid=true면 빈 배열. */
  errors: string[];
}

/** 퍼센트 표기 (불필요한 소수점 제거). */
function pct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

/**
 * 관리자가 학습방을 개설하며 정한 출결 기준값을 검증한다.
 * 프론트엔드는 방 생성 시 이 함수를 호출하고, errors 가 있으면 저장을 막고 그대로 노출한다.
 *
 * 핵심 검증: 정시기준(g)과 체류율 기준이 서로 충돌해 '지각' 판정이 불가능해지는 조합을 차단한다.
 * 세션 D분에서 지각자의 최대 체류율은 (D-g)/D 이므로,
 * 체류율 기준이 그 값 이상이면 모든 지각이 결석으로 처리되어 지각 등급이 사라진다.
 */
export function validateRoomSettings(
  settings: RuleSettings,
  sessionDurationMinutes: number,
): SettingsValidationResult {
  const errors: string[] = [];
  const { lateGraceMinutes, minAttendanceRatio } = settings;

  if (sessionDurationMinutes <= 0) {
    errors.push("세션 길이는 1분 이상이어야 합니다.");
    return { valid: false, errors };
  }
  if (minAttendanceRatio < 0 || minAttendanceRatio > 1) {
    errors.push("체류율 기준은 0%~100% 사이여야 합니다.");
  }
  if (lateGraceMinutes < 0) {
    errors.push("정시 기준(지각 유예) 분은 0 이상이어야 합니다.");
  }
  if (lateGraceMinutes >= sessionDurationMinutes) {
    errors.push(
      `정시 기준(${lateGraceMinutes}분)이 세션 길이(${sessionDurationMinutes}분)보다 짧아야 합니다.`,
    );
  }

  // 지각 등급이 존재 가능한지 검사 (위 기본 범위가 정상일 때만 의미 있음).
  if (
    errors.length === 0 &&
    minAttendanceRatio >= (sessionDurationMinutes - lateGraceMinutes) / sessionDurationMinutes
  ) {
    const maxLateRatio = (sessionDurationMinutes - lateGraceMinutes) / sessionDurationMinutes;
    errors.push(
      `체류율 기준(${pct(minAttendanceRatio)})이 너무 높아 '지각' 판정이 절대 발생할 수 없습니다. ` +
        `세션 ${sessionDurationMinutes}분 · 정시 기준 ${lateGraceMinutes}분에서는 늦게 들어온 사람의 최대 체류율이 ${pct(maxLateRatio)}이기 때문입니다. ` +
        `체류율 기준을 ${pct(maxLateRatio)} 미만으로 낮추거나, 정시 기준 분을 줄여주세요. ` +
        `(그대로 두면 3분만 늦어도 전부 결석으로 처리됩니다.)`,
    );
  }

  return { valid: errors.length === 0, errors };
}
