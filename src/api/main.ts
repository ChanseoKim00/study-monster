// 프로덕션 엔트리포인트 (Railway).
//   실행: node src/api/main.ts
// 필요한 환경변수(DATABASE_URL / DAILY_API_KEY / DAILY_WEBHOOK_SECRET)는
// Railway 환경변수로 주입한다. (코드/깃에 시크릿 금지 — 보안항목 #2)

import { loadConfig } from "./config.ts";
import { createPgPool, asQueryable } from "./pg.ts";
import { migrate } from "./migrate.ts";
import { createServer } from "./server.ts";
import { Db } from "./db.ts";
import { bootstrapAdmin, reissueAdminToken } from "./tokens.ts";

const PORT = Number(process.env.PORT ?? 8080);

const config = loadConfig(); // 시크릿 누락 시 여기서 기동 실패
const pool = createPgPool(config.databaseUrl);
const queryable = asQueryable(pool);

// 스키마 적용(멱등). 운영에선 별도 마이그레이션 단계로 분리해도 된다.
await migrate(queryable);

// 최초 관리자 부트스트랩: ADMIN_BOOTSTRAP_ID 가 있고 관리자가 없을 때만.
const db = new Db(queryable);
const env = process.env;
const adminId = env.ADMIN_BOOTSTRAP_ID?.trim();
const reissueRequested = env.ADMIN_REISSUE_TOKEN?.trim() === "true";
const boot = await bootstrapAdmin(db);
if (boot.created) {
  console.log("======================================================");
  console.log(" 최초 관리자 생성됨 (이 토큰은 이 로그에서만 1회 표시)");
  console.log("   memberId :", boot.memberId);
  console.log("   token    :", boot.token);
  console.log(" → 프론트에 붙여넣어 로그인하세요. 로그인 후 토큰을 보관하고");
  console.log("   ADMIN_BOOTSTRAP_ID 변수는 제거해도 됩니다.");
  console.log("======================================================");
} else if (!adminId) {
  // 진단: 부트스트랩 스킵 사유를 로그에 명시한다 (env 누락이 가장 흔한 사고).
  console.log(
    "[admin-bootstrap] ADMIN_BOOTSTRAP_ID 미설정 — 관리자 시드 스킵. " +
      "최초 1회 발급이 필요하면 Railway 환경변수에 ADMIN_BOOTSTRAP_ID=admin 을 설정하고 재배포하세요.",
  );
} else if (reissueRequested) {
  // env 는 있고 관리자도 이미 존재 — 분실 복구를 위해 새 토큰 강제 발급.
  const newToken = await reissueAdminToken(db, adminId);
  console.log("======================================================");
  console.log(" 관리자 토큰 재발급 (이 토큰은 이 로그에서만 1회 표시)");
  console.log("   memberId :", adminId);
  console.log("   token    :", newToken);
  console.log(" → 사용 후 ADMIN_REISSUE_TOKEN 변수는 반드시 제거하세요.");
  console.log("======================================================");
} else {
  console.log(
    "[admin-bootstrap] 관리자 이미 존재 — 새 토큰 발급 없이 스킵. " +
      "토큰을 분실했다면 ADMIN_REISSUE_TOKEN=true 를 설정하고 재배포하세요.",
  );
}

const server = createServer(queryable);
server.listen(PORT, () => {
  console.log(`study-monster 서버 기동: 포트 ${PORT}`);
});
