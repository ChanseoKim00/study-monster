import { Db, sql } from "./db.ts";
import type { AppConfig } from "./config.ts";
import { verifyDailyWebhook } from "./webhook.ts";
import {
  authenticate,
  requireAdmin,
  requireSelfOrAdmin,
  AuthnError,
  AuthzError,
} from "./auth.ts";
import { submitDisturbanceReport } from "./reports.ts";
import { declareReason, approveOtherReason } from "./reasons.ts";
import { computeMemberWeek } from "./aggregate.ts";
import { computeWeekSettlement, runAutoExit } from "./settlement.ts";
import { createMember, issueToken } from "./tokens.ts";
import type { Role } from "./auth.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { validateRoomSettings } from "../validation.ts";
import type { RuleSettings } from "../types.ts";

// 보안 모듈을 실제 엔드포인트로 묶는 라우트 레이어.
// 프레임워크 비종속: 요청/응답을 단순 객체로 다뤄 HTTP 서버 없이도 테스트 가능.
// (Next.js route / node http 어느 쪽에도 얇게 끼울 수 있다.)

export interface HttpRequest {
  method: string;
  /** 정규화된 경로 (예: "/webhooks/daily"). */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** 검증을 위해 반드시 raw 문자열로 보존 (재직렬화 금지). */
  rawBody: string;
  /** 파싱된 쿼리스트링 (선택). */
  query?: Record<string, string | undefined>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface Ctx {
  db: Db;
  config: AppConfig;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, body };
}

/** 인증/인가 예외를 적절한 상태코드로 변환. */
function errorResponse(e: unknown): HttpResponse {
  if (e instanceof AuthnError) return json(e.status, { error: e.message });
  if (e instanceof AuthzError) return json(e.status, { error: e.message });
  // 내부 오류는 상세를 노출하지 않는다.
  return json(500, { error: "내부 오류" });
}

/**
 * POST /webhooks/daily — Daily 출석 이벤트 수신.
 * 핵심 신뢰경계: 서명 검증을 통과하지 못한 요청은 DB 에 닿기 전에 거부한다.
 */
export async function handleDailyWebhook(
  ctx: Ctx,
  req: HttpRequest,
): Promise<HttpResponse> {
  const verdict = verifyDailyWebhook(req.rawBody, req.headers, {
    secret: ctx.config.dailyWebhookSecret,
    toleranceSeconds: ctx.config.webhookToleranceSeconds,
  });
  if (!verdict.ok) {
    // 위조/replay 시도는 401. 실패 '이유'는 서버 로그로만 남기고,
    // 응답 본문엔 노출하지 않는다(공격자에게 오라클을 주지 않기 위함).
    console.warn("webhook 서명 검증 실패:", verdict.reason);
    return json(401, { error: "서명 검증 실패" });
  }

  let event: {
    type?: string;
    daily_event_id?: string;
    payload?: { session_id?: string; member_id?: string; at?: string };
  };
  try {
    event = JSON.parse(req.rawBody);
  } catch {
    return json(400, { error: "잘못된 JSON" });
  }

  const kind =
    event.type === "participant.joined"
      ? "join"
      : event.type === "participant.left"
        ? "leave"
        : null;
  const p = event.payload;
  if (!kind || !p?.session_id || !p?.member_id || !p?.at) {
    return json(400, { error: "지원하지 않거나 불완전한 이벤트" });
  }

  // 멱등 삽입: 같은 Daily 이벤트 중복 수신 시 한 번만 반영 (replay 보강).
  await ctx.db.run(sql`
    INSERT INTO presence_events (session_id, member_id, kind, at, daily_event_id)
    VALUES (${p.session_id}, ${p.member_id}, ${kind}, ${p.at}, ${event.daily_event_id ?? null})
    ON CONFLICT (daily_event_id) DO NOTHING
  `);

  return json(200, { ok: true });
}

/**
 * PUT /admin/rooms/:roomId/settings — 규칙 설정 변경. 관리자 전용.
 */
export async function handleUpdateSettings(
  ctx: Ctx,
  req: HttpRequest,
  args: { roomId: string; sessionDurationMinutes: number },
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireAdmin(principal); // 일반 멤버는 설정 변경 불가

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.rawBody);
    } catch {
      return json(400, { error: "잘못된 JSON" });
    }
    if (!isRuleSettingsShape(parsed)) {
      return json(422, {
        error: "설정 형식이 올바르지 않습니다. 모든 기준값은 유한한 0 이상의 숫자여야 합니다.",
      });
    }
    const settings: RuleSettings = parsed;

    const validation = validateRoomSettings(settings, args.sessionDurationMinutes);
    if (!validation.valid) {
      return json(422, { error: "설정 검증 실패", details: validation.errors });
    }

    await ctx.db.run(sql`
      INSERT INTO rule_settings (room_id, settings, updated_by)
      VALUES (${args.roomId}, ${JSON.stringify(settings)}, ${principal.memberId})
      ON CONFLICT (room_id)
      DO UPDATE SET settings = EXCLUDED.settings,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = now()
    `);
    return json(200, { ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /admin/members/:memberId/exit — 강제 퇴장(비활성화). 관리자 전용.
 */
export async function handleForceExit(
  ctx: Ctx,
  req: HttpRequest,
  args: { memberId: string },
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireAdmin(principal);
    await ctx.db.run(sql`
      UPDATE members SET active = FALSE WHERE id = ${args.memberId}
    `);
    return json(200, { ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /reports/disturbance — 분위기저해 신고. 인증된 멤버만, 중복/자기신고 차단.
 */
export async function handleSubmitReport(
  ctx: Ctx,
  req: HttpRequest,
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    let body: { sessionId?: string; targetMemberId?: string };
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return json(400, { error: "잘못된 JSON" });
    }
    if (!body.sessionId || !body.targetMemberId) {
      return json(400, { error: "sessionId, targetMemberId 필요" });
    }
    const out = await submitDisturbanceReport(ctx.db, principal, {
      sessionId: body.sessionId,
      targetMemberId: body.targetMemberId,
    });
    return json(out.status === "recorded" ? 201 : 200, out);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /me — 토큰으로 내 신원 조회. 프론트가 역할(admin/member)에 따라 화면을 구성.
 */
export async function handleMe(
  ctx: Ctx,
  req: HttpRequest,
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    return json(200, principal);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /admin/members — 멤버 생성 + 1회용 토큰 발급. 관리자 전용.
 * 반환된 token 은 이 응답에서만 보인다(서버엔 해시만 저장). 멤버에게 안전하게 전달.
 */
export async function handleCreateMember(
  ctx: Ctx,
  req: HttpRequest,
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireAdmin(principal);
    let body: { id?: string; displayName?: string; role?: string };
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return json(400, { error: "잘못된 JSON" });
    }
    if (!body.id || !body.displayName) {
      return json(400, { error: "id, displayName 필요" });
    }
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") {
      return json(400, { error: "role 은 admin 또는 member 여야 합니다." });
    }
    await createMember(ctx.db, {
      id: body.id,
      displayName: body.displayName,
      role: body.role as Role | undefined,
    });
    const token = await issueToken(ctx.db, body.id);
    return json(201, { memberId: body.id, token });
  } catch (e) {
    return errorResponse(e);
  }
}

const MONDAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 저장된 방 설정을 불러온다. 없거나 roomId 미지정이면 기본값. */
async function loadSettings(
  ctx: Ctx,
  roomId: string | undefined,
): Promise<RuleSettings> {
  if (!roomId) return DEFAULT_SETTINGS;
  const row = await ctx.db.one<{ settings: RuleSettings }>(sql`
    SELECT settings FROM rule_settings WHERE room_id = ${roomId}
  `);
  // jsonb 는 드라이버가 객체로 돌려준다. 형식이 깨졌으면 기본값으로 안전 복귀.
  return row && isRuleSettingsShape(row.settings) ? row.settings : DEFAULT_SETTINGS;
}

/**
 * GET /weekly — 한 멤버의 한 주 벌금 판정. 본인 또는 관리자만.
 */
export async function handleWeeklyStatus(
  ctx: Ctx,
  req: HttpRequest,
  args: { memberId: string; mondayDate: string; roomId?: string },
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireSelfOrAdmin(principal, args.memberId); // 남의 현황 조회 차단
    if (!MONDAY_RE.test(args.mondayDate)) {
      return json(400, { error: "mondayDate 는 YYYY-MM-DD 형식이어야 합니다." });
    }
    const settings = await loadSettings(ctx, args.roomId);
    const result = await computeMemberWeek(ctx.db, settings, {
      memberId: args.memberId,
      mondayDate: args.mondayDate,
    });
    return json(200, result);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /admin/settlement — 한 주 정산(n분의1 환급). 관리자 전용.
 */
export async function handleSettlement(
  ctx: Ctx,
  req: HttpRequest,
  args: { mondayDate: string; roomId?: string },
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireAdmin(principal);
    if (!MONDAY_RE.test(args.mondayDate)) {
      return json(400, { error: "mondayDate 는 YYYY-MM-DD 형식이어야 합니다." });
    }
    const settings = await loadSettings(ctx, args.roomId);
    const result = await computeWeekSettlement(ctx.db, settings, {
      mondayDate: args.mondayDate,
    });
    return json(200, result);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /admin/auto-exit/run — 연속 벌금주 누적 멤버 자동 퇴장. 관리자 전용.
 */
export async function handleRunAutoExit(
  ctx: Ctx,
  req: HttpRequest,
  args: { throughMondayDate: string; roomId?: string },
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireAdmin(principal);
    if (!MONDAY_RE.test(args.throughMondayDate)) {
      return json(400, { error: "throughMondayDate 는 YYYY-MM-DD 형식이어야 합니다." });
    }
    const settings = await loadSettings(ctx, args.roomId);
    const decisions = await runAutoExit(ctx.db, settings, {
      throughMondayDate: args.throughMondayDate,
    });
    return json(200, { decisions });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 유한한 0 이상의 숫자인지. (NaN/Infinity/음수/비숫자 거부) */
function isNonNegNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * 신뢰 못 할 입력이 RuleSettings 구조를 갖췄는지 런타임 검증.
 * 관리자 입력이라도 누락/음수/NaN 같은 깨진 값을 DB 에 저장하지 않도록 막는다.
 */
function isRuleSettingsShape(v: unknown): v is RuleSettings {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const w = s.weights as Record<string, unknown> | undefined;
  const a = s.autoExit as Record<string, unknown> | undefined;
  if (typeof w !== "object" || w === null) return false;
  if (typeof a !== "object" || a === null) return false;
  return (
    isNonNegNum(s.lateGraceMinutes) &&
    isNonNegNum(s.minAttendanceRatio) &&
    s.minAttendanceRatio <= 1 &&
    isNonNegNum(w.lateUnexcused) &&
    isNonNegNum(w.absentUnexcused) &&
    isNonNegNum(w.vagueAbsent) &&
    isNonNegNum(w.disturbance) &&
    isNonNegNum(s.maxDisturbancePerSession) &&
    isNonNegNum(s.fineThreshold) &&
    isNonNegNum(s.fineAmount) &&
    isNonNegNum(s.personalLeaveWeeklyExemptLimit) &&
    isNonNegNum(a.warnAfterConsecutiveFineWeeks) &&
    isNonNegNum(a.exitAfterConsecutiveFineWeeks)
  );
}

/**
 * POST /reasons — 멤버가 자기 세션 출결 사유 신고. 본인 것만.
 */
export async function handleDeclareReason(
  ctx: Ctx,
  req: HttpRequest,
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    let body: { sessionId?: string; reason?: unknown };
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return json(400, { error: "잘못된 JSON" });
    }
    if (!body.sessionId) return json(400, { error: "sessionId 필요" });
    const out = await declareReason(ctx.db, principal, {
      sessionId: body.sessionId,
      memberId: principal.memberId, // 본인 고정 — 클라이언트가 대상 못 바꿈
      reason: body.reason,
    });
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /admin/reasons/approve — OTHER 사유 승인. 관리자 전용.
 */
export async function handleApproveReason(
  ctx: Ctx,
  req: HttpRequest,
): Promise<HttpResponse> {
  try {
    const principal = await authenticate(ctx.db, header(req, "authorization"));
    requireAdmin(principal);
    let body: { sessionId?: string; memberId?: string };
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return json(400, { error: "잘못된 JSON" });
    }
    if (!body.sessionId || !body.memberId) {
      return json(400, { error: "sessionId, memberId 필요" });
    }
    const approved = await approveOtherReason(ctx.db, principal, {
      sessionId: body.sessionId,
      memberId: body.memberId,
    });
    if (!approved) {
      return json(404, { error: "승인할 OTHER 사유가 없습니다." });
    }
    return json(200, { ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function header(req: HttpRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
