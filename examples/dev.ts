// 개발 서버: 프론트엔드 + API 를 인메모리 DB 로 띄운다.
//   실행: node examples/dev.ts   (또는 npm run dev)
// 실배포는 같은 createServer 에 pg.Pool 을 주입하면 된다(코드 동일).

import { InMemoryDb } from "./inMemoryDb.ts";
import { Db } from "../src/api/db.ts";
import { seedAdminIfNone, createMember } from "../src/api/tokens.ts";

const PORT = Number(process.env.PORT ?? 8787);

// 시크릿은 env 로만 (보안항목 #2). 데모용 더미값.
process.env.DATABASE_URL ??= "memory://dev";
process.env.DAILY_API_KEY ??= "dev-key";
process.env.DAILY_WEBHOOK_SECRET ??= Buffer.from("dev-webhook-secret").toString("base64");

const store = new InMemoryDb();
const db = new Db(store);

// 부트스트랩: 관리자 + 예시 멤버 2명.
const adminToken = (await seedAdminIfNone(db, { id: "admin", displayName: "관리자" }))!;
await createMember(db, { id: "m1", displayName: "철수" });
await createMember(db, { id: "m2", displayName: "영희" });

const { createServer } = await import("../src/api/server.ts");
const server = createServer(store);
server.listen(PORT, () => {
  console.log("\n========================================");
  console.log(` study-monster dev 서버: http://localhost:${PORT}`);
  console.log("----------------------------------------");
  console.log(" 브라우저에서 위 주소를 열고, 아래 관리자 토큰을 붙여넣어 접속:");
  console.log("\n   " + adminToken + "\n");
  console.log(" (멤버 토큰은 관리자 화면의 '멤버 추가'로 발급)");
  console.log("========================================\n");
});
