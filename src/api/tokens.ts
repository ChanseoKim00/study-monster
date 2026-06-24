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

/**
 * 분실 복구용: 지정 멤버에게 새 토큰을 발급한다.
 * - 대상이 존재하지 않거나 admin 이 아니면 예외 (권한 상승 차단).
 * - 기존 토큰은 모두 폐기해 분실/유출 시 즉시 무력화한다.
 * - 평문은 호출자(=로그)로 1회만 반환. DB 엔 해시만 남는다.
 *
 * 운영 흐름: 토큰을 잃은 관리자가 Railway 에 ADMIN_REISSUE_TOKEN=true 를 설정 →
 * 재배포 → 로그로 새 토큰 수령 → env var 제거.
 */
export async function reissueAdminToken(
  db: Db,
  memberId: string,
): Promise<string> {
  const row = await db.one<{ role: string; active: boolean }>(sql`
    SELECT role, active FROM members WHERE id = ${memberId}
  `);
  if (!row) {
    throw new Error(
      `관리자 토큰 재발급 실패: 멤버 '${memberId}' 가 존재하지 않습니다.`,
    );
  }
  if (row.role !== "admin") {
    throw new Error(
      `관리자 토큰 재발급 실패: '${memberId}' 는 관리자가 아닙니다.`,
    );
  }
  // 기존 토큰 폐기 (분실/유출 가정 — 새 토큰만 살린다).
  await db.run(sql`DELETE FROM auth_tokens WHERE member_id = ${memberId}`);
  // 비활성 관리자라도 복구는 가능해야 하므로 active 복원.
  if (!row.active) {
    await db.run(sql`UPDATE members SET active = TRUE WHERE id = ${memberId}`);
  }
  return issueToken(db, memberId);
}

export interface BootstrapResult {
  /** 이번 부팅에서 관리자를 새로 만들었는지. */
  created: boolean;
  memberId?: string;
  /** 새로 발급된 관리자 토큰(평문). created=true 일 때만. */
  token?: string;
}

/**
 * 환경변수 기반 최초 관리자 부트스트랩 (배포 직후 로그인 입구).
 * ADMIN_BOOTSTRAP_ID 가 있고 아직 관리자가 없으면 관리자를 시드하고 토큰을 반환한다.
 * 관리자가 이미 있으면 아무것도 하지 않는다(멱등) → 변수를 남겨둬도 안전.
 *
 * 호출 측(main.ts)이 token 을 로그에 1회 출력한다. 운영자는 로그인 후
 * 토큰을 안전히 보관하고, 원하면 이 변수를 제거하면 된다.
 */
export async function bootstrapAdmin(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  const id = env.ADMIN_BOOTSTRAP_ID?.trim();
  if (!id) return { created: false };
  const token = await seedAdminIfNone(db, {
    id,
    displayName: env.ADMIN_BOOTSTRAP_NAME?.trim() || id,
  });
  if (!token) return { created: false };
  return { created: true, memberId: id, token };
}
