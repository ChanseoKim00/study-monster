import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleDailyWebhook,
  handleUpdateSettings,
  handleForceExit,
  handleSubmitReport,
  handleWeeklyStatus,
  handleSettlement,
  handleRunAutoExit,
  handleMe,
  handleCreateMember,
  type Ctx,
  type HttpRequest,
} from "../../src/api/handlers.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";
import { computeSignature, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "../../src/api/webhook.ts";
import { hashToken } from "../../src/api/auth.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

const SECRET = Buffer.from("wh-secret").toString("base64");

function ctx(fake: FakeQueryable): Ctx {
  return {
    db: new Db(fake),
    config: {
      databaseUrl: "x",
      dailyApiKey: "x",
      dailyWebhookSecret: SECRET,
      webhookToleranceSeconds: 300,
    },
  };
}

function signedWebhook(eventObj: unknown): HttpRequest {
  const rawBody = JSON.stringify(eventObj);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    path: "/webhooks/daily",
    rawBody,
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: computeSignature(ts, rawBody, SECRET),
    },
  };
}

// admin/member 토큰을 흉내내는 인증 행.
function authRow(role: "admin" | "member") {
  return { member_id: role === "admin" ? "admin1" : "m1", role, active: true, expires_at: null };
}

test("webhook: 서명 없는 가짜 입장 이벤트는 401, DB 미접근", async () => {
  const fake = new FakeQueryable();
  const req: HttpRequest = {
    method: "POST",
    path: "/webhooks/daily",
    rawBody: JSON.stringify({ type: "participant.joined" }),
    headers: {}, // 서명 없음
  };
  const res = await handleDailyWebhook(ctx(fake), req);
  assert.equal(res.status, 401);
  assert.equal(fake.calls.length, 0); // 출석 기록 안 됨
});

test("webhook: 위조된 본문은 401", async () => {
  const fake = new FakeQueryable();
  const req = signedWebhook({ type: "participant.left", payload: {} });
  req.rawBody = JSON.stringify({ type: "participant.joined" }); // 서명 후 본문 변조
  const res = await handleDailyWebhook(ctx(fake), req);
  assert.equal(res.status, 401);
  assert.equal(fake.calls.length, 0);
});

test("webhook: 진짜 서명 + 유효 이벤트는 멱등 삽입", async () => {
  const fake = new FakeQueryable().enqueue([], 1);
  const req = signedWebhook({
    type: "participant.joined",
    daily_event_id: "evt-1",
    payload: { session_id: "s1", member_id: "m1", at: "2026-06-23T22:00:00Z" },
  });
  const res = await handleDailyWebhook(ctx(fake), req);
  assert.equal(res.status, 200);
  assert.ok(fake.lastCall.text.includes("INSERT INTO presence_events"));
  assert.ok(fake.lastCall.text.includes("ON CONFLICT")); // 멱등
  assert.deepEqual(fake.lastCall.params, [
    "s1", "m1", "join", "2026-06-23T22:00:00Z", "evt-1",
  ]);
});

test("admin: 일반 멤버의 설정 변경 시도는 403", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]);
  const req: HttpRequest = {
    method: "PUT",
    path: "/admin/rooms/r1/settings",
    rawBody: JSON.stringify(DEFAULT_SETTINGS),
    headers: { authorization: "Bearer member-token" },
  };
  const res = await handleUpdateSettings(ctx(fake), req, {
    roomId: "r1",
    sessionDurationMinutes: 90,
  });
  assert.equal(res.status, 403);
  // 인증 조회(1회)만, UPDATE 안 일어남.
  assert.equal(fake.calls.length, 1);
});

test("admin: 관리자 설정 변경은 검증 통과 후 저장", async () => {
  const fake = new FakeQueryable().enqueue([authRow("admin")]).enqueue([], 1);
  const req: HttpRequest = {
    method: "PUT",
    path: "/admin/rooms/r1/settings",
    rawBody: JSON.stringify(DEFAULT_SETTINGS),
    headers: { authorization: "Bearer admin-token" },
  };
  const res = await handleUpdateSettings(ctx(fake), req, {
    roomId: "r1",
    sessionDurationMinutes: 120, // 5분/95% 가 충돌 없이 통과하는 길이
  });
  assert.equal(res.status, 200);
  assert.ok(fake.calls[1].text.includes("INSERT INTO rule_settings"));
});

test("admin: 충돌나는 설정은 422 로 거부", async () => {
  const fake = new FakeQueryable().enqueue([authRow("admin")]);
  const bad = { ...DEFAULT_SETTINGS, lateGraceMinutes: 5, minAttendanceRatio: 0.99 };
  const req: HttpRequest = {
    method: "PUT",
    path: "/admin/rooms/r1/settings",
    rawBody: JSON.stringify(bad),
    headers: { authorization: "Bearer admin-token" },
  };
  const res = await handleUpdateSettings(ctx(fake), req, {
    roomId: "r1",
    sessionDurationMinutes: 60, // 95%+ 충돌 유발
  });
  assert.equal(res.status, 422);
});

test("admin: 깨진 설정(음수/누락)은 422, 저장 안 함", async () => {
  const fake = new FakeQueryable().enqueue([authRow("admin")]);
  const broken = { ...DEFAULT_SETTINGS, fineAmount: -1 };
  const req: HttpRequest = {
    method: "PUT",
    path: "/admin/rooms/r1/settings",
    rawBody: JSON.stringify(broken),
    headers: { authorization: "Bearer admin-token" },
  };
  const res = await handleUpdateSettings(ctx(fake), req, {
    roomId: "r1",
    sessionDurationMinutes: 120,
  });
  assert.equal(res.status, 422);
  assert.equal(fake.calls.length, 1); // 인증만, INSERT 없음
});

test("webhook 실패 응답엔 실패 reason 을 노출하지 않는다 (오라클 차단)", async () => {
  const res = await handleDailyWebhook(ctx(new FakeQueryable()), {
    method: "POST",
    path: "/webhooks/daily",
    rawBody: "{}",
    headers: {},
  });
  assert.equal(res.status, 401);
  assert.ok(!("reason" in (res.body as object)));
});

test("admin: 토큰 없는 강제퇴장은 401", async () => {
  const fake = new FakeQueryable();
  const req: HttpRequest = {
    method: "POST",
    path: "/admin/members/m1/exit",
    rawBody: "",
    headers: {},
  };
  const res = await handleForceExit(ctx(fake), req, { memberId: "m1" });
  assert.equal(res.status, 401);
});

test("admin: 관리자 강제퇴장은 멤버 비활성화", async () => {
  const fake = new FakeQueryable().enqueue([authRow("admin")]).enqueue([], 1);
  const req: HttpRequest = {
    method: "POST",
    path: "/admin/members/m1/exit",
    rawBody: "",
    headers: { authorization: "Bearer admin-token" },
  };
  const res = await handleForceExit(ctx(fake), req, { memberId: "m1" });
  assert.equal(res.status, 200);
  assert.ok(fake.calls[1].text.includes("UPDATE members SET active = FALSE"));
  assert.deepEqual(fake.calls[1].params, ["m1"]);
});

test("report: 인증 안 된 신고는 401", async () => {
  const fake = new FakeQueryable();
  const req: HttpRequest = {
    method: "POST",
    path: "/reports/disturbance",
    rawBody: JSON.stringify({ sessionId: "s1", targetMemberId: "t1" }),
    headers: {},
  };
  const res = await handleSubmitReport(ctx(fake), req);
  assert.equal(res.status, 401);
});

test("report: 인증된 신고는 201(recorded)", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]).enqueue([], 1);
  const req: HttpRequest = {
    method: "POST",
    path: "/reports/disturbance",
    rawBody: JSON.stringify({ sessionId: "s1", targetMemberId: "t1" }),
    headers: { authorization: "Bearer member-token" },
  };
  const res = await handleSubmitReport(ctx(fake), req);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { status: "recorded" });
});

test("report: 중복 신고는 200(duplicate)", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]).enqueue([], 0);
  const req: HttpRequest = {
    method: "POST",
    path: "/reports/disturbance",
    rawBody: JSON.stringify({ sessionId: "s1", targetMemberId: "t1" }),
    headers: { authorization: "Bearer member-token" },
  };
  const res = await handleSubmitReport(ctx(fake), req);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "duplicate" });
});

// 인증 흐름이 실제로 토큰 해시를 사용하는지 (평문 미사용) 한 번 더 못박기.
test("report 인증은 토큰 해시로 조회", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]).enqueue([], 1);
  const req: HttpRequest = {
    method: "POST",
    path: "/reports/disturbance",
    rawBody: JSON.stringify({ sessionId: "s1", targetMemberId: "t1" }),
    headers: { authorization: "Bearer secret-token" },
  };
  await handleSubmitReport(ctx(fake), req);
  assert.ok((fake.calls[0].params as string[]).includes(hashToken("secret-token")));
});

// ── B2/B3: 집계/정산/자동퇴장 인가 ──

test("weekly: 남의 현황 조회는 403", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]); // m1
  const req: HttpRequest = {
    method: "GET",
    path: "/weekly",
    rawBody: "",
    headers: { authorization: "Bearer t" },
  };
  const res = await handleWeeklyStatus(ctx(fake), req, {
    memberId: "someone-else",
    mondayDate: "2026-06-22",
  });
  assert.equal(res.status, 403);
});

test("weekly: 잘못된 mondayDate 형식은 400", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]);
  const req: HttpRequest = {
    method: "GET", path: "/weekly", rawBody: "",
    headers: { authorization: "Bearer t" },
  };
  const res = await handleWeeklyStatus(ctx(fake), req, {
    memberId: "m1", mondayDate: "2026/06/22",
  });
  assert.equal(res.status, 400);
});

test("weekly: 본인 현황은 조회 가능(200)", async () => {
  const fake = new FakeQueryable()
    .enqueue([authRow("member")]) // 인증
    .enqueue([]); // 그 주 세션 없음 → fine 0
  const req: HttpRequest = {
    method: "GET", path: "/weekly", rawBody: "",
    headers: { authorization: "Bearer t" },
  };
  const res = await handleWeeklyStatus(ctx(fake), req, {
    memberId: "m1", mondayDate: "2026-06-22",
  });
  assert.equal(res.status, 200);
});

test("settlement: 일반 멤버는 403", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]);
  const req: HttpRequest = {
    method: "GET", path: "/admin/settlement", rawBody: "",
    headers: { authorization: "Bearer t" },
  };
  const res = await handleSettlement(ctx(fake), req, { mondayDate: "2026-06-22" });
  assert.equal(res.status, 403);
});

test("auto-exit: 토큰 없으면 401", async () => {
  const fake = new FakeQueryable();
  const req: HttpRequest = {
    method: "POST", path: "/admin/auto-exit/run", rawBody: "", headers: {},
  };
  const res = await handleRunAutoExit(ctx(fake), req, { throughMondayDate: "2026-06-22" });
  assert.equal(res.status, 401);
});

test("auto-exit: 관리자는 실행 가능(200)", async () => {
  const fake = new FakeQueryable()
    .enqueue([authRow("admin")]) // 인증
    .enqueue([]); // 활성 멤버 없음 → 결정 빈 배열
  const req: HttpRequest = {
    method: "POST", path: "/admin/auto-exit/run", rawBody: "",
    headers: { authorization: "Bearer admin-token" },
  };
  const res = await handleRunAutoExit(ctx(fake), req, { throughMondayDate: "2026-06-22" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { decisions: [] });
});

// ── /me, /admin/members ──

test("me: 유효 토큰이면 신원 반환", async () => {
  const fake = new FakeQueryable().enqueue([authRow("admin")]);
  const res = await handleMe(ctx(fake), {
    method: "GET", path: "/me", rawBody: "",
    headers: { authorization: "Bearer t" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { memberId: "admin1", role: "admin" });
});

test("me: 토큰 없으면 401", async () => {
  const res = await handleMe(ctx(new FakeQueryable()), {
    method: "GET", path: "/me", rawBody: "", headers: {},
  });
  assert.equal(res.status, 401);
});

test("create member: 일반 멤버는 403", async () => {
  const fake = new FakeQueryable().enqueue([authRow("member")]);
  const res = await handleCreateMember(ctx(fake), {
    method: "POST", path: "/admin/members",
    rawBody: JSON.stringify({ id: "m9", displayName: "x" }),
    headers: { authorization: "Bearer t" },
  });
  assert.equal(res.status, 403);
});

test("create member: 관리자는 생성+토큰 발급(201), 토큰은 평문 1회 반환", async () => {
  const fake = new FakeQueryable()
    .enqueue([authRow("admin")]) // 인증
    .enqueue([], 1) // createMember
    .enqueue([], 1); // issueToken
  const res = await handleCreateMember(ctx(fake), {
    method: "POST", path: "/admin/members",
    rawBody: JSON.stringify({ id: "m9", displayName: "민수" }),
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(res.status, 201);
  const body = res.body as { memberId: string; token: string };
  assert.equal(body.memberId, "m9");
  assert.ok(body.token && body.token.length > 0);
});

test("create member: 잘못된 role 거부(400)", async () => {
  const fake = new FakeQueryable().enqueue([authRow("admin")]);
  const res = await handleCreateMember(ctx(fake), {
    method: "POST", path: "/admin/members",
    rawBody: JSON.stringify({ id: "m9", displayName: "x", role: "superuser" }),
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(res.status, 400);
});
