import { Db, sql } from "./db.ts";
import { AuthzError, type Principal } from "./auth.ts";

// 분위기저해 신고 어뷰징 방지 (기획 보안항목 #5).
//
// 코어(warnings.ts)는 이미 "세션당 분위기저해 가산 1회 상한"을 적용한다.
// 하지만 그건 '몇 점을 줄지'의 상한일 뿐, '누가 신고했는지/중복 신고인지'는 모른다.
// 이 레이어가 다음을 책임진다:
//   1. 신고자 인증 — 익명/위조 신고 차단 (authenticate 로 얻은 Principal 필요).
//   2. 자기 자신 신고 금지.
//   3. (세션, 신고자, 대상) 중복 신고 차단 — DB UNIQUE 제약으로 원천 봉쇄.
// 이렇게 모은 "유효 신고자 수"를 코어의 disturbanceReports 입력으로 넘긴다.

export type ReportOutcome =
  | { status: "recorded" } // 새 신고 기록됨
  | { status: "duplicate" }; // 이미 같은 신고가 있어 무시 (멱등)

/**
 * 분위기저해 신고를 기록한다.
 * - reporter 는 인증된 Principal 이어야 한다(호출 전 authenticate 완료 전제).
 * - 자기 자신 신고는 거부(AuthzError).
 * - 같은 (세션, 신고자, 대상) 중복은 조용히 무시(멱등) → 어뷰징/연타 무효화.
 */
export async function submitDisturbanceReport(
  db: Db,
  reporter: Principal,
  params: { sessionId: string; targetMemberId: string },
): Promise<ReportOutcome> {
  const { sessionId, targetMemberId } = params;

  if (reporter.memberId === targetMemberId) {
    throw new AuthzError("자기 자신을 신고할 수 없습니다.");
  }

  // ON CONFLICT DO NOTHING: UNIQUE(session, reporter, target) 위반 시 중복으로 처리.
  const { rowCount } = await db.run(sql`
    INSERT INTO disturbance_reports (session_id, reporter_id, target_member_id)
    VALUES (${sessionId}, ${reporter.memberId}, ${targetMemberId})
    ON CONFLICT ON CONSTRAINT uq_report_once DO NOTHING
  `);

  return rowCount > 0 ? { status: "recorded" } : { status: "duplicate" };
}

/**
 * 한 세션에서 특정 대상에 대한 "고유 신고자 수"를 센다.
 * 이 값이 코어 evaluateSession 의 disturbanceReports 입력이 된다.
 * (UNIQUE 제약 덕에 사실상 신고 행 수 = 고유 신고자 수)
 */
export async function countDistinctReporters(
  db: Db,
  params: { sessionId: string; targetMemberId: string },
): Promise<number> {
  const row = await db.one<{ n: string }>(sql`
    SELECT COUNT(DISTINCT reporter_id) AS n
    FROM disturbance_reports
    WHERE session_id = ${params.sessionId}
      AND target_member_id = ${params.targetMemberId}
  `);
  return row ? Number(row.n) : 0;
}
