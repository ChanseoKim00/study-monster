// 프로덕션 엔트리포인트 (Railway).
//   실행: node src/api/main.ts
// 필요한 환경변수(DATABASE_URL / DAILY_API_KEY / DAILY_WEBHOOK_SECRET)는
// Railway 환경변수로 주입한다. (코드/깃에 시크릿 금지 — 보안항목 #2)

import { loadConfig } from "./config.ts";
import { createPgPool, asQueryable } from "./pg.ts";
import { migrate } from "./migrate.ts";
import { createServer } from "./server.ts";
import { Db } from "./db.ts";
import { bootstrapAdmin } from "./tokens.ts";

const PORT = Number(process.env.PORT ?? 8080);

const config = loadConfig(); // 시크릿 누락 시 여기서 기동 실패
const pool = createPgPool(config.databaseUrl);
const queryable = asQueryable(pool);

// 스키마 적용(멱등). 운영에선 별도 마이그레이션 단계로 분리해도 된다.
await migrate(queryable);

// 최초 관리자 부트스트랩: ADMIN_BOOTSTRAP_ID 가 있고 관리자가 없을 때만.
const boot = await bootstrapAdmin(new Db(queryable));
if (boot.created) {
  console.log("======================================================");
  console.log(" 최초 관리자 생성됨 (이 토큰은 이 로그에서만 1회 표시)");
  console.log("   memberId :", boot.memberId);
  console.log("   token    :", boot.token);
  console.log(" → 프론트에 붙여넣어 로그인하세요. 로그인 후 토큰을 보관하고");
  console.log("   ADMIN_BOOTSTRAP_ID 변수는 제거해도 됩니다.");
  console.log("======================================================");
}

const server = createServer(queryable);
server.listen(PORT, () => {
  console.log(`study-monster 서버 기동: 포트 ${PORT}`);
});
