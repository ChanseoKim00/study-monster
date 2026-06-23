// 실제 SQL 엔진(pg-mem) 위에서 전체 스택을 end-to-end 실행한다.
//   실행: node examples/dbRun.ts   (또는 npm run db:demo)
//
// 손으로 짠 fake 가 아니라, 우리의 실제 schema.sql + 실제 파라미터화 쿼리
// (ON CONFLICT, UNIQUE/CHECK 제약, FK, COUNT(DISTINCT), 집계)를 진짜 SQL 로 돌린다.
// 프로덕션은 pg-mem 대신 createPgPool(DATABASE_URL) 만 주입하면 동일하게 동작한다.

import { newDb } from "pg-mem";
import { Db, sql } from "../src/api/db.ts";
import { asQueryable } from "../src/api/pg.ts";
import { migrate } from "../src/api/migrate.ts";
import { seedAdminIfNone, createMember, issueToken } from "../src/api/tokens.ts";
import { computeSignature } from "../src/api/webhook.ts";
import { handleDailyWebhook, type Ctx } from "../src/api/handlers.ts";
import { submitDisturbanceReport, countDistinctReporters } from "../src/api/reports.ts";
import { declareReason } from "../src/api/reasons.ts";
import { computeMemberWeek } from "../src/api/aggregate.ts";
import { computeWeekSettlement } from "../src/api/settlement.ts";
import { authenticate } from "../src/api/auth.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

const SECRET = Buffer.from("db-demo-secret").toString("base64");
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : " " + detail}`);
  cond ? pass++ : fail++;
}

// ── 진짜 SQL 엔진 기동 + 스키마 마이그레이션 ──
const mem = newDb();
const { Pool } = mem.adapters.createPg();
const pool = new Pool();
const queryable = asQueryable(pool);
const db = new Db(queryable);

console.log("\n=== 실제 SQL(pg-mem) end-to-end ===\n");
console.log("[0] 마이그레이션 (schema.sql 실제 실행)");
await migrate(queryable);
const tables = await db.run<{ table_name: string }>(sql`
  SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
`);
check("테이블 생성됨", tables.rowCount >= 6, `(got ${tables.rowCount})`);
console.log("     " + tables.rows.map((r) => r.table_name).join(", "));

// ── 시드: 관리자 + 멤버 + 세션 2개(같은 주) ──
console.log("\n[1] 시드 (관리자/멤버/세션)");
const adminToken = (await seedAdminIfNone(db, { id: "admin", displayName: "관리자" }))!;
await createMember(db, { id: "m1", displayName: "철수" });
await createMember(db, { id: "m2", displayName: "영희" });
const m2Token = await issueToken(db, "m2");
// 같은 주(2026-06-22 월) 안의 두 세션. KST 22:00~24:00 ≈ UTC 13:00~15:00.
for (const [id, day] of [["s1", "22"], ["s2", "23"]] as const) {
  await db.run(sql`
    INSERT INTO sessions (id, starts_at, ends_at)
    VALUES (${id}, ${`2026-06-${day}T13:00:00Z`}, ${`2026-06-${day}T15:00:00Z`})
  `);
}
check("관리자 토큰 발급", adminToken.length > 0);
const sess = await db.run(sql`SELECT id FROM sessions`);
check("세션 2건 저장", sess.rowCount === 2);

const ctx: Ctx = {
  db,
  config: { databaseUrl: "pg-mem", dailyApiKey: "x", dailyWebhookSecret: SECRET, webhookToleranceSeconds: 300 },
};

// ── Daily webhook(서명검증)으로 m2 출석 기록 → 실제 presence_events 적재 ──
console.log("\n[2] Daily webhook → presence_events 적재 (서명 검증)");
async function sendPresence(sessionId: string, memberId: string, kind: string, at: string, eventId: string) {
  const rawBody = JSON.stringify({ type: kind === "join" ? "participant.joined" : "participant.left",
    daily_event_id: eventId, payload: { session_id: sessionId, member_id: memberId, at } });
  const ts = String(Math.floor(Date.now() / 1000));
  return handleDailyWebhook(ctx, {
    method: "POST", path: "/webhooks/daily", rawBody,
    headers: { "x-webhook-timestamp": ts, "x-webhook-signature": computeSignature(ts, rawBody, SECRET) },
  });
}
// admin·m2 는 두 세션 모두 정시 입장~끝까지 체류(PRESENT). m1 은 미입장(결석).
for (const s of ["s1", "s2"]) {
  const day = s === "s1" ? "22" : "23";
  for (const mid of ["admin", "m2"]) {
    await sendPresence(s, mid, "join", `2026-06-${day}T13:00:00Z`, `${s}-${mid}-join`);
    await sendPresence(s, mid, "leave", `2026-06-${day}T15:00:00Z`, `${s}-${mid}-leave`);
  }
}
const pe = await db.run(sql`SELECT count(*)::int AS n FROM presence_events`);
check("presence_events 8건 적재", (pe.rows[0] as { n: number }).n === 8);

// 위조 서명은 거부되어 적재 안 됨.
const forged = await handleDailyWebhook(ctx, {
  method: "POST", path: "/webhooks/daily",
  rawBody: JSON.stringify({ type: "participant.joined", payload: { session_id: "s1", member_id: "m1", at: "2026-06-22T13:00:00Z" } }),
  headers: {},
});
check("서명 없는 가짜 입장 → 401 (적재 안 됨)", forged.status === 401);

// ── 사유 신고 + 분위기저해 신고(중복/자기신고) ──
console.log("\n[3] 신고 (사유 / 분위기저해)");
const m2Principal = await authenticate(db, `Bearer ${m2Token}`);
await declareReason(db, m2Principal, { sessionId: "s1", memberId: "m2", reason: "OVERTIME" });
const r1 = await submitDisturbanceReport(db, m2Principal, { sessionId: "s1", targetMemberId: "m1" });
await submitDisturbanceReport(db, m2Principal, { sessionId: "s1", targetMemberId: "m1" }); // 중복 시도
check("분위기저해 신고 recorded", r1.status === "recorded");
// 무결성 검증: UNIQUE 제약이 실제로 중복 행 생성을 막았는지(행 수=1).
// (실제 Postgres 는 ON CONFLICT DO NOTHING 시 rowCount=0 → 코드가 "duplicate" 반환.
//  pg-mem 은 rowCount 를 1 로 보고하는 차이가 있어, 여기선 행 수로 직접 확인한다.)
const drCount = await db.run(sql`SELECT count(*)::int AS n FROM disturbance_reports`);
check("중복 신고 행 미생성 (UNIQUE 제약 실동작, 총 1건)", (drCount.rows[0] as { n: number }).n === 1);
let selfErr = false;
try { await submitDisturbanceReport(db, m2Principal, { sessionId: "s1", targetMemberId: "m2" }); }
catch { selfErr = true; }
check("자기신고 거부", selfErr);
const cnt = await countDistinctReporters(db, { sessionId: "s1", targetMemberId: "m1" });
check("고유 신고자 수 = 1", cnt === 1);

// ── 주간 벌금 판정(실제 행 집계) ──
console.log("\n[4] 주간 벌금 판정 (실제 presence/사유/신고 집계)");
const wk1 = await computeMemberWeek(db, DEFAULT_SETTINGS, { memberId: "m1", mondayDate: "2026-06-22" });
const wk2 = await computeMemberWeek(db, DEFAULT_SETTINGS, { memberId: "m2", mondayDate: "2026-06-22" });
console.log("     m1:", JSON.stringify(wk1));
console.log("     m2:", JSON.stringify(wk2));
// m1: 무단결석 2회(2.0) + m2의 분위기저해 신고 1건(0.5) = 2.5점 → 임계 2.0 초과 → 벌금.
check("m1 무단결석+신고 2.5점 → 벌금 부과", wk1.totalPoints === 2.5 && wk1.fine === DEFAULT_SETTINGS.fineAmount);
check("m2 개근 → 벌금 0", wk2.fine === 0);

// ── 정산(n분의1) ──
console.log("\n[5] 정산 (n분의1 환급)");
const settle = await computeWeekSettlement(db, DEFAULT_SETTINGS, { mondayDate: "2026-06-22" });
console.log("     " + JSON.stringify(settle));
check("총 벌금 5000, 참가자 3명 → 1인당 1666 + 잔액 2",
  settle.totalFines === 5000 && settle.participantCount === 3 && settle.perPerson === 1666 && settle.remainder === 2);
// 개근한 admin/m2 도 1666 을 환급받는다 — 결석한 m1 이 전원에게 보상을 나눠주는 구조.

console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
process.exitCode = fail === 0 ? 0 : 1;
