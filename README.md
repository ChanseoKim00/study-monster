# study-monster

친구들끼리 매일 22~23시 화상 스터디의 출석을 자동 추적하고, 지각/결석/분위기저해를
규칙대로 경고·벌금으로 환산하며, 모인 벌금을 참가자 전원에게 n분의1 환급하고,
경고가 누적된 멤버는 사람이 아니라 시스템이 자동으로 제외하는 스터디 관리 앱.

핵심 가치: **친구 사이의 불편한 강제력 행사를 시스템 규칙으로 대체한다.**

## 현재 범위 — 규칙 엔진 코어

화상 SDK / DB / UI 와 독립적인 순수 판정 로직. 기획서 7번의 검증 케이스를
그대로 테스트로 고정해 두었다.

```
src/
  types.ts          도메인 타입 + 관리자 설정값(RuleSettings)
  settings.ts       조정 가능한 기본값
  attendance.ts     5분/95% 출결 판정 매트릭스
  warnings.ts       사유 분류 + 경고 가중치 + 분위기저해 가산
  fines.ts          주간 벌금(섞이면 부과) + n분의1 정산
  autoExit.ts       연속 벌금주 → 자동 퇴장
  sessionWindow.ts  화상 입/퇴장 이벤트 → 출결 입력 (Daily.co webhook 직결)
  weekly.ts         월요일 주 버킷 + 연속 벌금주 카운트
  validation.ts     관리자 설정 충돌 차단 + 한국어 에러 메시지
test/               기획서 케이스 + 이벤트/주간/검증/E2E 테스트
```

의존성 0. Node 24+ 에서 TypeScript를 네이티브로 실행한다.

## 신뢰경계 / 보안 레이어 (`src/api/`)

규칙 코어와 외부(Daily webhook · 멤버 요청) 사이의 신뢰경계. 프레임워크 비종속
순수 핸들러라 Next.js / node http 어느 쪽에도 얇게 끼울 수 있다.

```
src/api/
  config.ts    시크릿은 Railway env 에서만 로드, 누락 시 기동 실패, 값 비노출 (#2)
  webhook.ts   Daily HMAC-SHA256 서명 검증 + timing-safe 비교 + replay 방어 (#1)
  db.ts        sql 태그드 템플릿으로 파라미터 바인딩 구조적 강제 (#3)
  schema.sql   members/auth_tokens/presence_events/disturbance_reports/rule_settings
  auth.ts      토큰 해시 인증 + role 기반 관리자 인가/권한 분리 (#4)
  reports.ts   신고자 인증 + (세션,신고자,대상) 중복 차단 + 자기신고 금지 (#5)
  tokens.ts    crypto 랜덤 토큰 발급(평문 1회 반환, DB엔 해시만) + 관리자 시드
  reasons.ts   본인 출결 사유 신고(대리 차단) + OTHER 관리자 승인
  aggregate.ts presence_events(+사유+신고) → 코어 판정 → 주간 벌금
  settlement.ts 주간 n분의1 환급 계산 + 연속 벌금주 자동 퇴장
  handlers.ts  webhook/admin/report/사유/주간/정산/자동퇴장 엔드포인트로 통합
  server.ts    node http 어댑터 (webhook raw body 보존, 본문 1MB 상한)
```

엔드포인트:

```
POST /webhooks/daily            Daily 출석 이벤트 (서명 검증 필수)
POST /reports/disturbance       분위기저해 신고 (인증, 중복/자기신고 차단)
POST /reasons                   본인 출결 사유 신고
POST /admin/reasons/approve     OTHER 사유 승인 (관리자)
PUT  /admin/rooms/:id/settings  규칙 설정 변경 (관리자, 구조·충돌 검증)
POST /admin/members/:id/exit    강제 퇴장 (관리자)
GET  /weekly?memberId&mondayDate         주간 벌금 판정 (본인/관리자)
GET  /admin/settlement?mondayDate        주간 정산 n분의1 (관리자)
POST /admin/auto-exit/run?mondayDate     연속 벌금주 자동 퇴장 (관리자)
GET  /me                                 토큰으로 내 신원 조회
POST /admin/members                      멤버 생성 + 1회용 토큰 발급 (관리자)
GET  /                                   프론트엔드(단일 HTML) 서빙
```

참고: 정산/자동퇴장은 멤버×주×세션을 코어로 재계산하는 N+1 쿼리다. 친구 규모(소수)
에선 무해하지만, 멤버가 늘면 세션별 SessionResult 캐싱/집계 쿼리로 최적화 여지가 있다.

핵심 신뢰경계: **서명 검증을 통과하지 못한 webhook 은 DB 에 닿기 전에 거부**한다.
검증이 없으면 멤버가 가짜 입장 이벤트를 직접 쏴서 출석을 조작할 수 있기 때문.

시크릿은 `.env.example` 의 이름들을 Railway 환경변수로 설정한다. (`.env` 는 커밋 금지)

## 프론트엔드 (`public/index.html`)

의존성 0의 단일 HTML + vanilla JS. 서버가 `GET /` 로 서빙한다. 관리자가 발급한
액세스 토큰을 붙여넣어 접속하고, 역할(admin/member)에 따라 화면이 구성된다.
멤버: 주간 현황·사유 신고·분위기저해 신고. 관리자: 멤버 추가(토큰 발급)·정산·
자동 퇴장·강제 퇴장·OTHER 사유 승인. (프로덕션은 동일 API 계약으로 Next.js 이전 가능)

## 실행

```bash
npm test          # 전체 테스트
npm run demo      # 라이브 신뢰경계 데모(HTTP 시나리오, 인메모리)
npm run dev       # 프론트+API 개발 서버 → http://localhost:8787
                  #   (콘솔에 출력된 관리자 토큰으로 접속)
```

`demo`/`dev` 는 인메모리 저장소를 쓴다(영속성 없음). 실배포는 같은 `createServer`
에 `pg.Pool` 만 주입하면 된다.

## 다음 단계

1. 실제 PostgreSQL 연결(`pg.Pool`) + 마이그레이션 러너 + Railway 배포
2. Daily.co 클라이언트 SDK 연동(화상 + 출석 webhook 송출)
3. (선택) 프론트엔드 Next.js 이전

스택: PostgreSQL + Daily.co(무료 티어) + Railway. 추가 비용 $0/월 목표.
