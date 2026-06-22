// 주(week) 단위 집계 유틸. 경고는 매주 월요일에 집계 기준이 새로 시작된다(기획서 2.3).
// 이력은 보존하고 "이번 주 누적치"만 보는 방식이므로, 세션을 주 단위로 버킷팅한다.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 주어진 시각이 속한 주의 "월요일 날짜"를 YYYY-MM-DD 로 반환한다 (주간 버킷 키).
 *
 * 서버 타임존에 의존하지 않도록 UTC 오프셋을 명시적으로 받는다.
 * 기본값 540분 = KST(UTC+9) — 친구들이 한국 시간 22시에 모이므로.
 */
export function weekStartMonday(at: Date, utcOffsetMinutes = 540): string {
  const local = new Date(at.getTime() + utcOffsetMinutes * 60000);
  // getUTC* 로 읽으면 오프셋이 반영된 "현지" 날짜 성분이 된다.
  const dow = local.getUTCDay(); // 0=일 … 1=월
  const daysSinceMonday = (dow + 6) % 7; // 월=0, 일=6
  const monday = new Date(local.getTime() - daysSinceMonday * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

/**
 * 주별 "벌금 부과 여부"를 시간순으로 받아, 가장 최근까지 연속으로 이어진
 * 벌금 주 수를 센다. 이 값을 evaluateAutoExit 에 넘기면 자동 퇴장이 판정된다.
 */
export function consecutiveFineWeeks(finedByWeekChrono: boolean[]): number {
  let count = 0;
  for (let i = finedByWeekChrono.length - 1; i >= 0; i--) {
    if (finedByWeekChrono[i]) count++;
    else break;
  }
  return count;
}
