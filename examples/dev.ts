// 개발 서버: 프론트엔드 + API 를 "실제 SQL 엔진"(pg-mem) 위에서 띄운다.
//   실행: node examples/dev.ts   (또는 npm run dev)
// 실배포는 examples/start.ts(실제 pg + DATABASE_URL)를 쓴다 — 코드 경로는 동일.

import { newDb } from "pg-mem";
import { Db, sql } from "../src/api/db.ts";
import { asQueryable } from "../src/api/pg.ts";
import { migrate } from "../src/api/migrate.ts";
import { seedAdminIfNone, createMember } from "../src/api/tokens.ts";

const PORT = Number(process.env.PORT ?? 8787);

// 시크릿은 env 로만 (보안항목 #2). 데모용 더미값.
process.env.DATABASE_URL ??= "memory://dev";
process.env.DAILY_API_KEY ??= "dev-key";
process.env.DAILY_WEBHOOK_SECRET ??= Buffer.from("dev-webhook-secret").toString("base64");

// 실제 SQL 엔진 + 스키마 마이그레이션.
const mem = newDb();
const { Pool } = mem.adapters.createPg();
const queryable = asQueryable(new Pool());
const db = new Db(queryable);
await migrate(queryable);

// 부트스트랩: 관리자 + 예시 멤버 2명 + 이번 주 세션 2개(설정/정산 클릭용).
const adminToken = (await seedAdminIfNone(db, { id: "admin", displayName: "관리자" }))!;
await createMember(db, { id: "m1", displayName: "철수" });
await createMember(db, { id: "m2", displayName: "영희" });
for (const [id, day] of [["s1", "22"], ["s2", "23"]] as const) {
  await db.run(sql`
    INSERT INTO sessions (id, starts_at, ends_at)
    VALUES (${id}, ${`2026-06-${day}T13:00:00Z`}, ${`2026-06-${day}T15:00:00Z`})
  `);
}

const { createServer } = await import("../src/api/server.ts");
const server = createServer(queryable);
server.listen(PORT, () => {
  console.log("\n========================================");
  console.log(` study-monster dev 서버 (실제 SQL/pg-mem): http://localhost:${PORT}`);
  console.log("----------------------------------------");
  console.log(" 브라우저에서 위 주소를 열고, 아래 관리자 토큰을 붙여넣어 접속:");
  console.log("\n   " + adminToken + "\n");
  console.log(" 예시 세션 s1, s2 / 멤버 m1, m2 가 준비돼 있습니다.");
  console.log(" (멤버 토큰은 관리자 화면의 '멤버 추가'로 발급)");
  console.log("========================================\n");
});
