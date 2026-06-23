// 프로덕션 엔트리포인트 (Railway).
//   실행: node src/api/main.ts
// 필요한 환경변수(DATABASE_URL / DAILY_API_KEY / DAILY_WEBHOOK_SECRET)는
// Railway 환경변수로 주입한다. (코드/깃에 시크릿 금지 — 보안항목 #2)

import { loadConfig } from "./config.ts";
import { createPgPool, asQueryable } from "./pg.ts";
import { migrate } from "./migrate.ts";
import { createServer } from "./server.ts";

const PORT = Number(process.env.PORT ?? 8080);

const config = loadConfig(); // 시크릿 누락 시 여기서 기동 실패
const pool = createPgPool(config.databaseUrl);
const queryable = asQueryable(pool);

// 스키마 적용(멱등). 운영에선 별도 마이그레이션 단계로 분리해도 된다.
await migrate(queryable);

const server = createServer(queryable);
server.listen(PORT, () => {
  console.log(`study-monster 서버 기동: 포트 ${PORT}`);
});
