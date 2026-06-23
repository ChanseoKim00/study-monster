import type { Queryable } from "../src/api/db.ts";

// 데모 전용 인메모리 Queryable.
// 실제 배포에선 pg.Pool 을 주입한다(드라이버가 $n 바인딩을 네이티브 처리).
// 여기선 우리가 생성하는 SQL 텍스트를 패턴 매칭해 최소 동작만 흉내낸다.
// 목적: HTTP 신뢰경계(서명/인증/인가/중복차단)가 실제로 동작함을 라이브로 보이기.

interface Member { id: string; role: string; active: boolean; }
interface Token { memberId: string; expiresAt: string | null; }

export class InMemoryDb implements Queryable {
  members = new Map<string, Member>();
  tokens = new Map<string, Token>(); // token_hash -> token
  reports = new Set<string>(); // `${session}|${reporter}|${target}`
  presence: Record<string, unknown>[] = [];
  seenEventIds = new Set<string>();

  async query<R = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    const t = text.replace(/\s+/g, " ").trim();

    // 인증: 토큰 해시로 멤버 조회
    if (t.includes("FROM auth_tokens t JOIN members m")) {
      const tok = this.tokens.get(params[0] as string);
      if (!tok) return this.res([]);
      const m = this.members.get(tok.memberId)!;
      return this.res([
        { member_id: m.id, role: m.role, active: m.active, expires_at: tok.expiresAt },
      ] as R[]);
    }

    // 관리자 수 카운트
    if (t.includes("COUNT(*) AS n FROM members WHERE role = 'admin'")) {
      const n = [...this.members.values()].filter((m) => m.role === "admin").length;
      return this.res([{ n: String(n) }] as R[]);
    }

    // 멤버 생성
    if (t.startsWith("INSERT INTO members")) {
      const [id, , role] = params as string[];
      if (!this.members.has(id)) this.members.set(id, { id, role, active: true });
      return this.res([], 1);
    }

    // 토큰 발급
    if (t.startsWith("INSERT INTO auth_tokens")) {
      const [hash, memberId, expiresAt] = params as (string | null)[];
      this.tokens.set(hash as string, { memberId: memberId as string, expiresAt: (expiresAt as string) ?? null });
      return this.res([], 1);
    }

    // 출석 이벤트 멱등 삽입
    if (t.startsWith("INSERT INTO presence_events")) {
      const [session_id, member_id, kind, at, eventId] = params as (string | null)[];
      if (eventId && this.seenEventIds.has(eventId)) return this.res([], 0);
      if (eventId) this.seenEventIds.add(eventId);
      this.presence.push({ session_id, member_id, kind, at });
      return this.res([], 1);
    }

    // 분위기저해 신고 (중복 차단)
    if (t.startsWith("INSERT INTO disturbance_reports")) {
      const [session, reporter, target] = params as string[];
      const key = `${session}|${reporter}|${target}`;
      if (this.reports.has(key)) return this.res([], 0);
      this.reports.add(key);
      return this.res([], 1);
    }

    // 강제 퇴장
    if (t.startsWith("UPDATE members SET active = FALSE")) {
      const m = this.members.get(params[0] as string);
      if (m) m.active = false;
      return this.res([], m ? 1 : 0);
    }

    // 그 외(설정/집계 등)는 빈 결과 — 데모 범위 밖.
    return this.res([]);
  }

  private res<R>(rows: R[], rowCount = rows.length) {
    return Promise.resolve({ rows, rowCount });
  }
}
