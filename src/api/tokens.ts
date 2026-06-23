import crypto from "node:crypto";
import { Db, sql } from "./db.ts";
import { hashToken, type Role } from "./auth.ts";

// 인증 부트스트랩: 멤버 생성 + 불투명 토큰 발급.
//
// 보안:
//   - 토큰은 crypto.randomBytes 로 만든 고엔트로피 랜덤값(base64url).
//   - DB 에는 평문이 아니라 sha256 해시만 저장한다(auth.ts hashToken 과 동일 방식).
//   - 평문 토큰은 발급 시점에 단 한 번만 호출자에게 돌려주고, 어디에도 다시 저장하지 않는다.

/** 고엔트로피 불투명 토큰(평문) 생성. 32바이트 → base64url. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 멤버 생성(이미 있으면 그대로 둠). role 기본 member. */
export async function createMember(
  db: Db,
  params: { id: string; displayName: string; role?: Role },
): Promise<void> {
  await db.run(sql`
    INSERT INTO members (id, display_name, role)
    VALUES (${params.id}, ${params.displayName}, ${params.role ?? "member"})
    ON CONFLICT (id) DO NOTHING
  `);
}

/**
 * 멤버에게 새 토큰을 발급한다. 평문 토큰을 반환하고, DB 엔 해시만 저장한다.
 * 반환된 평문은 호출자(=발급 대상)에게 즉시 전달한 뒤 버려야 한다.
 */
export async function issueToken(
  db: Db,
  memberId: string,
  opts: { expiresAt?: Date } = {},
): Promise<string> {
  const token = generateToken();
  await db.run(sql`
    INSERT INTO auth_tokens (token_hash, member_id, expires_at)
    VALUES (${hashToken(token)}, ${memberId}, ${opts.expiresAt ?? null})
  `);
  return token;
}

/** 토큰 폐기(로그아웃/유출 대응). 평문을 받아 해시로 지운다. */
export async function revokeToken(db: Db, token: string): Promise<boolean> {
  const { rowCount } = await db.run(sql`
    DELETE FROM auth_tokens WHERE token_hash = ${hashToken(token)}
  `);
  return rowCount > 0;
}

/**
 * 최초 관리자 시드. 관리자가 한 명도 없을 때만 생성하고 토큰을 발급한다.
 * 이미 관리자가 있으면 null 을 반환(중복 생성 방지).
 * 반환된 평문 토큰은 운영자가 안전하게 보관해야 한다(로그 노출 금지).
 */
export async function seedAdminIfNone(
  db: Db,
  params: { id: string; displayName: string },
): Promise<string | null> {
  const existing = await db.one<{ n: string }>(sql`
    SELECT COUNT(*) AS n FROM members WHERE role = 'admin'
  `);
  if (existing && Number(existing.n) > 0) return null;

  await createMember(db, { ...params, role: "admin" });
  return issueToken(db, params.id);
}
