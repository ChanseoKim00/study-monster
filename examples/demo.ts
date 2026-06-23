// 라이브 데모: 실제 HTTP 서버를 띄워 신뢰경계가 동작하는지 확인한다.
//   실행: node examples/demo.ts
// (인메모리 DB 사용 — 실배포는 pg.Pool 주입. 로직/엔드포인트는 실제 코드 그대로.)

import { InMemoryDb } from "./inMemoryDb.ts";
import { computeSignature } from "../src/api/webhook.ts";
import { Db } from "../src/api/db.ts";
import { seedAdminIfNone, createMember, issueToken } from "../src/api/tokens.ts";

const PORT = 8787;
const SECRET = Buffer.from("demo-webhook-secret").toString("base64");

// 서버가 읽을 env (시크릿은 env 로만 — 보안항목 #2).
process.env.DATABASE_URL = "memory://demo";
process.env.DAILY_API_KEY = "demo-key";
process.env.DAILY_WEBHOOK_SECRET = SECRET;

const store = new InMemoryDb();
const db = new Db(store);

// 부트스트랩: 관리자 시드 + 멤버 2명 + m1 토큰.
const adminToken = (await seedAdminIfNone(db, { id: "admin", displayName: "관리자" }))!;
await createMember(db, { id: "m1", displayName: "철수" });
await createMember(db, { id: "m2", displayName: "영희" });
const m1Token = await issueToken(db, "m1");

// 서버 기동 (createServer 는 loadConfig 로 env 검증).
const { createServer } = await import("../src/api/server.ts");
const server = createServer(store);
await new Promise<void>((r) => server.listen(PORT, r));

const base = `http://localhost:${PORT}`;
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✅ ${name}`);
    pass++;
  } else {
    console.log(`  ❌ ${name} ${detail}`);
    fail++;
  }
}

async function req(path: string, init: RequestInit) {
  const res = await fetch(base + path, init);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* 빈 본문 */ }
  return { status: res.status, body };
}

function signedWebhook(eventObj: unknown) {
  const rawBody = JSON.stringify(eventObj);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": ts,
      "x-webhook-signature": computeSignature(ts, rawBody, SECRET),
    },
    body: rawBody,
  };
}

console.log("\n=== study-monster 라이브 신뢰경계 데모 ===\n");

console.log("[1] webhook 서명 검증 (핵심 신뢰경계)");
{
  // 가짜 입장 이벤트 — 서명 없음.
  const forged = await req("/webhooks/daily", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "participant.joined", payload: { session_id: "s1", member_id: "m1", at: new Date().toISOString() } }),
  });
  check("서명 없는 가짜 입장 → 401 거부", forged.status === 401, `(got ${forged.status})`);
  check("   └ DB에 출석 기록 안 됨", store.presence.length === 0);

  // 진짜 Daily 서명.
  const real = await req("/webhooks/daily", signedWebhook({
    type: "participant.joined",
    daily_event_id: "evt-1",
    payload: { session_id: "s1", member_id: "m1", at: new Date().toISOString() },
  }));
  check("올바른 서명 → 200 수락", real.status === 200, `(got ${real.status})`);
  check("   └ DB에 출석 1건 기록", store.presence.length === 1);

  // 같은 이벤트 재전송(replay) → 멱등.
  const replay = await req("/webhooks/daily", signedWebhook({
    type: "participant.joined",
    daily_event_id: "evt-1",
    payload: { session_id: "s1", member_id: "m1", at: new Date().toISOString() },
  }));
  check("같은 event_id 재전송 → 멱등(중복 기록 안 됨)", replay.status === 200 && store.presence.length === 1);
}

console.log("\n[2] 인증/인가");
{
  const noAuth = await req("/reports/disturbance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", targetMemberId: "m2" }),
  });
  check("토큰 없는 신고 → 401", noAuth.status === 401, `(got ${noAuth.status})`);

  const memberForceExit = await req("/admin/members/m2/exit", {
    method: "POST",
    headers: { authorization: `Bearer ${m1Token}` },
  });
  check("일반 멤버의 강제퇴장 시도 → 403", memberForceExit.status === 403, `(got ${memberForceExit.status})`);
  check("   └ m2 여전히 활성", store.members.get("m2")!.active === true);

  const adminForceExit = await req("/admin/members/m2/exit", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check("관리자 강제퇴장 → 200", adminForceExit.status === 200, `(got ${adminForceExit.status})`);
  check("   └ m2 비활성화됨", store.members.get("m2")!.active === false);
}

console.log("\n[3] 신고 어뷰징 방지");
{
  const first = await req("/reports/disturbance", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${m1Token}` },
    body: JSON.stringify({ sessionId: "s1", targetMemberId: "admin" }),
  });
  check("정상 신고 → 201 recorded", first.status === 201, `(got ${first.status})`);

  const dup = await req("/reports/disturbance", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${m1Token}` },
    body: JSON.stringify({ sessionId: "s1", targetMemberId: "admin" }),
  });
  check("동일 신고 재전송 → 200 duplicate (중복 차단)", dup.status === 200 && (dup.body as { status?: string }).status === "duplicate");

  const self = await req("/reports/disturbance", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${m1Token}` },
    body: JSON.stringify({ sessionId: "s1", targetMemberId: "m1" }),
  });
  check("자기 자신 신고 → 403", self.status === 403, `(got ${self.status})`);
}

console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
await new Promise<void>((r) => server.close(() => r()));
process.exitCode = fail === 0 ? 0 : 1;
