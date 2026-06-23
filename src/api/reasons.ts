import { Db, sql } from "./db.ts";
import { AuthzError, requireAdmin, type Principal } from "./auth.ts";
import type { ReasonCategory } from "../types.ts";

// 출결 사유 신고 + OTHER 관리자 승인 (기획서 3.3).
//
// 권한 분리:
//   - 사유 신고는 "본인 것만" 가능(남의 결석에 사유를 달 수 없음).
//   - OTHER 승인은 관리자만 가능(멤버가 자기 사유를 스스로 정당화 못 함).

const SELF_DECLARABLE: ReasonCategory[] = [
  "OVERTIME",
  "SELF_DEVELOPMENT",
  "VAGUE_PERSONAL",
  "OTHER",
  "NONE",
];

function isReasonCategory(v: unknown): v is ReasonCategory {
  return typeof v === "string" && SELF_DECLARABLE.includes(v as ReasonCategory);
}

/**
 * 멤버가 자기 세션 사유를 신고(upsert). 본인만 가능.
 * 사유를 다시 내면 덮어쓰고, OTHER 가 아니면 승인 상태를 초기화한다.
 */
export async function declareReason(
  db: Db,
  principal: Principal,
  params: { sessionId: string; memberId: string; reason: unknown },
): Promise<{ reason: ReasonCategory }> {
  // 본인 사유만. (관리자라도 대리 신고는 막아 사유 출처를 분명히 한다.)
  if (principal.memberId !== params.memberId) {
    throw new AuthzError("본인 사유만 신고할 수 있습니다.");
  }
  if (!isReasonCategory(params.reason)) {
    throw new AuthzError("알 수 없는 사유 카테고리입니다.");
  }
  const reason = params.reason;

  // 사유 변경 시 승인 상태 리셋: OTHER→다른값으로 바꿨다가 다시 OTHER 로 돌려
  // 과거 승인을 재사용하는 우회를 막는다.
  await db.run(sql`
    INSERT INTO attendance_reasons (session_id, member_id, reason, other_approved)
    VALUES (${params.sessionId}, ${params.memberId}, ${reason}, FALSE)
    ON CONFLICT (session_id, member_id)
    DO UPDATE SET reason = EXCLUDED.reason,
                  other_approved = FALSE,
                  approved_by = NULL,
                  created_at = now()
  `);
  return { reason };
}

/**
 * 관리자가 OTHER 사유를 승인. 관리자만, 그리고 실제로 OTHER 인 행에만 적용된다.
 * @returns 승인된 행이 있으면 true.
 */
export async function approveOtherReason(
  db: Db,
  admin: Principal,
  params: { sessionId: string; memberId: string },
): Promise<boolean> {
  requireAdmin(admin);
  const { rowCount } = await db.run(sql`
    UPDATE attendance_reasons
    SET other_approved = TRUE, approved_by = ${admin.memberId}
    WHERE session_id = ${params.sessionId}
      AND member_id = ${params.memberId}
      AND reason = 'OTHER'
  `);
  return rowCount > 0;
}

/** 한 세션·멤버의 사유 조회 (집계 파이프라인 입력). 없으면 NONE 으로 본다. */
export async function getReason(
  db: Db,
  params: { sessionId: string; memberId: string },
): Promise<{ reason: ReasonCategory; otherApproved: boolean }> {
  const row = await db.one<{ reason: ReasonCategory; other_approved: boolean }>(sql`
    SELECT reason, other_approved
    FROM attendance_reasons
    WHERE session_id = ${params.sessionId} AND member_id = ${params.memberId}
  `);
  if (!row) return { reason: "NONE", otherApproved: false };
  return { reason: row.reason, otherApproved: row.other_approved };
}
