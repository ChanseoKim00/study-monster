import type { SessionTiming } from "./types.ts";

/** 하루치 스터디 시간 구간 (예: 그날 22:00 ~ 23:00). */
export interface TimeWindow {
  start: Date;
  end: Date;
}

/** 화상 SDK(Daily.co 등)가 보내는 입/퇴장 이벤트 1건. */
export interface PresenceEvent {
  type: "join" | "leave";
  at: Date;
}

/** [start, end) 로 클램프한 구간. 유효하지 않으면 null. */
function clampInterval(
  from: Date,
  to: Date,
  window: TimeWindow,
): [number, number] | null {
  const a = Math.max(from.getTime(), window.start.getTime());
  const b = Math.min(to.getTime(), window.end.getTime());
  return b > a ? [a, b] : null;
}

/**
 * 한 멤버의 입/퇴장 이벤트들을 스터디 구간과 대조해 출결 판정 입력으로 환산한다.
 *
 * - 재접속(여러 join/leave 쌍)을 모두 합산해 체류 비율을 계산한다.
 * - 마지막 leave 가 없으면(끝까지 머묾) 구간 종료 시각에 나간 것으로 본다.
 * - minutesAfterStart 는 첫 입장 기준. 시작 전 입장이면 0 이하가 되어 정시로 처리된다.
 *
 * Daily.co webhook 의 participant.joined / participant.left 가 이 함수의 입력이 된다.
 */
export function buildSessionTiming(
  events: PresenceEvent[],
  window: TimeWindow,
): SessionTiming {
  const durationMs = window.end.getTime() - window.start.getTime();
  if (durationMs <= 0) {
    throw new Error("TimeWindow.end 는 start 보다 뒤여야 합니다.");
  }

  const sorted = [...events].sort((x, y) => x.at.getTime() - y.at.getTime());

  let presentMs = 0;
  let openJoin: Date | null = null;
  let firstJoin: Date | null = null;

  for (const ev of sorted) {
    if (ev.type === "join") {
      if (firstJoin === null) firstJoin = ev.at;
      if (openJoin === null) openJoin = ev.at; // 중복 join 은 무시
    } else {
      if (openJoin !== null) {
        const seg = clampInterval(openJoin, ev.at, window);
        if (seg) presentMs += seg[1] - seg[0];
        openJoin = null;
      }
    }
  }

  // 구간 끝까지 leave 없이 머문 경우.
  if (openJoin !== null) {
    const seg = clampInterval(openJoin, window.end, window);
    if (seg) presentMs += seg[1] - seg[0];
  }

  const joined = firstJoin !== null && presentMs > 0;
  const minutesAfterStart =
    firstJoin === null
      ? 0
      : (firstJoin.getTime() - window.start.getTime()) / 60000;

  return {
    joined,
    minutesAfterStart,
    attendanceRatio: Math.min(presentMs / durationMs, 1),
  };
}
