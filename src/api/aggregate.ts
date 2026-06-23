import { Db, sql } from "./db.ts";
import { getReason } from "./reasons.ts";
import { countDistinctReporters } from "./reports.ts";
import { buildSessionTiming, type PresenceEvent } from "../sessionWindow.ts";
import { evaluateSession } from "../warnings.ts";
import { computeWeeklyFine, type WeeklyFineResult } from "../fines.ts";
import { weekStartMonday } from "../weekly.ts";
import type { RuleSettings, SessionResult } from "../types.ts";

// 저장된 데이터를 규칙 코어로 흘려보내는 집계 파이프라인.
//   presence_events(+사유+분위기저해 신고) → 코어 판정 → SessionResult → 주간 벌금.
//
// 모든 쿼리는 파라미터 바인딩(sql 태그). 신뢰경계를 통과한 데이터만 다룬다.

/** KST 기준 한 주의 [from, to) UTC 구간을 구한다. (월요일 00:00 ~ 다음 월 00:00) */
export function weekRange(
  mondayDate: string, // 'YYYY-MM-DD' (weekStartMonday 의 출력)
  utcOffsetMinutes = 540,
): { from: Date; to: Date } {
  const [y, m, d] = mondayDate.split("-").map(Number);
  // 현지 자정의 실제 UTC 순간 = UTC자정 - 오프셋.
  const from = new Date(Date.UTC(y, m - 1, d) - utcOffsetMinutes * 60000);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * 한 멤버의 한 세션을 코어 판정해 SessionResult 로 만든다.
 * 세션이 없으면 null.
 */
export async function aggregateSession(
  db: Db,
  settings: RuleSettings,
  params: { sessionId: string; memberId: string },
): Promise<SessionResult | null> {
  const session = await db.one<{ starts_at: string; ends_at: string }>(sql`
    SELECT starts_at, ends_at FROM sessions WHERE id = ${params.sessionId}
  `);
  if (!session) return null;

  const { rows } = await db.run<{ kind: "join" | "leave"; at: string }>(sql`
    SELECT kind, at FROM presence_events
    WHERE session_id = ${params.sessionId} AND member_id = ${params.memberId}
    ORDER BY at ASC
  `);
  const events: PresenceEvent[] = rows.map((r) => ({
    type: r.kind,
    at: new Date(r.at),
  }));

  const timing = buildSessionTiming(events, {
    start: new Date(session.starts_at),
    end: new Date(session.ends_at),
  });

  const { reason, otherApproved } = await getReason(db, params);
  const disturbanceReports = await countDistinctReporters(db, {
    sessionId: params.sessionId,
    targetMemberId: params.memberId,
  });

  return evaluateSession(
    { timing, reason, otherApproved, disturbanceReports },
    settings,
  );
}

/**
 * 한 멤버의 한 주(월요일 기준) 벌금 판정.
 * 해당 주에 속한 모든 세션을 집계해 computeWeeklyFine 에 넘긴다.
 */
export async function computeMemberWeek(
  db: Db,
  settings: RuleSettings,
  params: { memberId: string; mondayDate: string; utcOffsetMinutes?: number },
): Promise<WeeklyFineResult> {
  const { from, to } = weekRange(params.mondayDate, params.utcOffsetMinutes);
  const { rows } = await db.run<{ id: string }>(sql`
    SELECT id FROM sessions
    WHERE starts_at >= ${from.toISOString()} AND starts_at < ${to.toISOString()}
    ORDER BY starts_at ASC
  `);

  const results: SessionResult[] = [];
  for (const { id } of rows) {
    const r = await aggregateSession(db, settings, {
      sessionId: id,
      memberId: params.memberId,
    });
    if (r) results.push(r);
  }
  return computeWeeklyFine(results, settings);
}

/** 편의: Date 로부터 그 주의 월요일 키를 구해 멤버 주간 판정. */
export function mondayKeyOf(at: Date, utcOffsetMinutes = 540): string {
  return weekStartMonday(at, utcOffsetMinutes);
}
