import crypto from "node:crypto";
import { Db, sql } from "./db.ts";

// 인증 + 인가 (기획 보안항목 #4 — 관리자 엔드포인트 인가, 권한 분리).
//
// 인증: 클라이언트는 Bearer 토큰을 보낸다. 평문 토큰은 DB에 저장하지 않고,
//       sha256 해시로만 대조한다. (DB 유출 시 토큰 원문이 새지 않게)
// 인가: role 이 'admin' 인 멤버만 설정변경/강제퇴장/정산 같은 관리 작업을 할 수 있다.
//       일반 멤버는 자기 경고를 못 지우고, 남의 데이터를 못 바꾼다.

export type Role = "admin" | "member";

/** 인증된 호출자. */
export interface Principal {
  memberId: string;
  role: Role;
}

/** 401 — 신원 확인 실패. */
export class AuthnError extends Error {
  readonly status = 401;
  constructor(message = "인증이 필요합니다.") {
    super(message);
    this.name = "AuthnError";
  }
}

/** 403 — 신원은 확인됐으나 권한 부족. */
export class AuthzError extends Error {
  readonly status = 403;
  constructor(message = "권한이 없습니다. 관리자만 가능한 작업입니다.") {
    super(message);
    this.name = "AuthzError";
  }
}

/** 토큰을 저장/조회용 해시로 변환. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Authorization 헤더에서 Bearer 토큰을 추출. */
export function extractBearer(
  authorization: string | undefined,
): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : null;
}

/**
 * Bearer 토큰을 검증해 Principal 을 돌려준다. 실패 시 AuthnError.
 * - 토큰 해시로 조회 (파라미터 바인딩).
 * - 만료/비활성 멤버 거부.
 */
export async function authenticate(
  db: Db,
  authorization: string | undefined,
): Promise<Principal> {
  const token = extractBearer(authorization);
  if (!token) throw new AuthnError();

  const tokenHash = hashToken(token);
  const row = await db.one<{
    member_id: string;
    role: Role;
    active: boolean;
    expires_at: string | null;
  }>(sql`
    SELECT m.id AS member_id, m.role AS role, m.active AS active,
           t.expires_at AS expires_at
    FROM auth_tokens t
    JOIN members m ON m.id = t.member_id
    WHERE t.token_hash = ${tokenHash}
  `);

  if (!row) throw new AuthnError("토큰이 유효하지 않습니다.");
  if (!row.active) throw new AuthnError("비활성화된 계정입니다.");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AuthnError("토큰이 만료되었습니다.");
  }

  return { memberId: row.member_id, role: row.role };
}

/** 관리자 권한 강제. admin 이 아니면 AuthzError. */
export function requireAdmin(principal: Principal): void {
  if (principal.role !== "admin") throw new AuthzError();
}

/**
 * "자기 자신 또는 관리자" 강제.
 * 일반 멤버가 남의 리소스를 건드리는 것을 막되, 관리자는 모두 가능.
 */
export function requireSelfOrAdmin(
  principal: Principal,
  targetMemberId: string,
): void {
  if (principal.role === "admin") return;
  if (principal.memberId !== targetMemberId) throw new AuthzError();
}
