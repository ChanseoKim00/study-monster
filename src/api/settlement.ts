import { Db, sql } from "./db.ts";
import { computeMemberWeek } from "./aggregate.ts";
import { computeSettlement, type SettlementResult } from "../fines.ts";
import { consecutiveFineWeeks } from "../weekly.ts";
import { evaluateAutoExit, type MemberStatus } from "../autoExit.ts";
import type { RuleSettings } from "../types.ts";

// 정산(n분의1 환급) + 자동 퇴장. 둘 다 관리자 트리거(핸들러에서 인가).

const DAY_MS = 24 * 60 * 60 * 1000;

/** 월요일 키('YYYY-MM-DD')에서 k주 전 월요일 키를 구한다. */
function mondayMinusWeeks(mondayDate: string, k: number): string {
  const [y, m, d] = mondayDate.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  return new Date(base - k * 7 * DAY_MS).toISOString().slice(0, 10);
}

export interface MemberFine {
  memberId: string;
  fine: number;
}

export interface WeekSettlement extends SettlementResult {
  mondayDate: string;
  /** 멤버별 부과 벌금(0 포함). */
  breakdown: MemberFine[];
}

/**
 * 한 주의 정산: 활성 참가자 전원의 벌금 합을 모아 n분의1 환급액을 계산한다.
 * 개근자도 1/n 을 받는다(지각/결석자가 전원에게 보상을 나눠주는 구조).
 */
export async function computeWeekSettlement(
  db: Db,
  settings: RuleSettings,
  params: { mondayDate: string; utcOffsetMinutes?: number },
): Promise<WeekSettlement> {
  const { rows } = await db.run<{ id: string }>(sql`
    SELECT id FROM members WHERE active = TRUE ORDER BY id ASC
  `);

  const breakdown: MemberFine[] = [];
  let totalFines = 0;
  for (const { id } of rows) {
    const week = await computeMemberWeek(db, settings, {
      memberId: id,
      mondayDate: params.mondayDate,
      utcOffsetMinutes: params.utcOffsetMinutes,
    });
    breakdown.push({ memberId: id, fine: week.fine });
    totalFines += week.fine;
  }

  const settlement = computeSettlement(totalFines, rows.length || 1);
  return { ...settlement, mondayDate: params.mondayDate, breakdown };
}

export interface AutoExitDecision {
  memberId: string;
  consecutiveFineWeeks: number;
  status: MemberStatus;
  /** 이번 실행에서 실제로 비활성화(퇴장 반영)됐는지. */
  deactivated: boolean;
}

/**
 * 활성 멤버 각각의 "가장 최근까지 연속된 벌금 주 수"를 보고 자동 퇴장을 판정·반영한다.
 * EXITED 판정이면 members.active=FALSE 로 비활성화한다(사람이 아니라 시스템이 결정).
 *
 * throughMondayDate(포함)부터 과거로 충분한 주(=퇴장 임계치)만큼만 본다.
 */
export async function runAutoExit(
  db: Db,
  settings: RuleSettings,
  params: { throughMondayDate: string; utcOffsetMinutes?: number },
): Promise<AutoExitDecision[]> {
  const lookback = settings.autoExit.exitAfterConsecutiveFineWeeks;
  const { rows } = await db.run<{ id: string }>(sql`
    SELECT id FROM members WHERE active = TRUE ORDER BY id ASC
  `);

  const decisions: AutoExitDecision[] = [];
  for (const { id } of rows) {
    // 오래된 주 → 최신 주 순서로 벌금 여부 배열을 만든다.
    const finedChrono: boolean[] = [];
    for (let k = lookback - 1; k >= 0; k--) {
      const monday = mondayMinusWeeks(params.throughMondayDate, k);
      const week = await computeMemberWeek(db, settings, {
        memberId: id,
        mondayDate: monday,
        utcOffsetMinutes: params.utcOffsetMinutes,
      });
      finedChrono.push(week.fine > 0);
    }
    const streak = consecutiveFineWeeks(finedChrono);
    const status = evaluateAutoExit(streak, settings);

    let deactivated = false;
    if (status === "EXITED") {
      await db.run(sql`UPDATE members SET active = FALSE WHERE id = ${id}`);
      deactivated = true;
    }
    decisions.push({ memberId: id, consecutiveFineWeeks: streak, status, deactivated });
  }
  return decisions;
}
