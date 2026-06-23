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
  handlers.ts  webhook/admin/report 엔드포인트로 위 모듈 통합
  server.ts    node http 어댑터 (webhook raw body 보존)
```

핵심 신뢰경계: **서명 검증을 통과하지 못한 webhook 은 DB 에 닿기 전에 거부**한다.
검증이 없으면 멤버가 가짜 입장 이벤트를 직접 쏴서 출석을 조작할 수 있기 때문.

시크릿은 `.env.example` 의 이름들을 Railway 환경변수로 설정한다. (`.env` 는 커밋 금지)

## 테스트

```bash
npm test
```

## 다음 단계

1. DB 스키마 + Next.js API (코어 호출, mock webhook 로 검증)
2. Daily.co 연동 + Railway 배포
3. 관리자 설정 + 정산 화면 UI

스택: Next.js + PostgreSQL + Daily.co(무료 티어) + Railway. 추가 비용 $0/월 목표.
