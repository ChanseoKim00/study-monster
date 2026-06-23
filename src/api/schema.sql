-- study-monster 스키마 (PostgreSQL).
-- 신뢰경계/인가/어뷰징 방지에 직접 관여하는 테이블 중심.

-- 멤버. role 로 관리자/일반 권한 분리 (보안항목 #4).
CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('admin', 'member')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 인증 토큰 (불투명 토큰의 해시만 저장 — 평문 토큰은 DB에 두지 않는다).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_member ON auth_tokens(member_id);

-- 일별 세션.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL
);

-- Daily webhook 으로 들어온 입/퇴장 이벤트 (서명 검증 통과분만 기록).
CREATE TABLE IF NOT EXISTS presence_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  member_id   TEXT NOT NULL REFERENCES members(id),
  kind        TEXT NOT NULL CHECK (kind IN ('join', 'leave')),
  at          TIMESTAMPTZ NOT NULL,
  -- webhook 멱등성: 같은 Daily 이벤트를 중복 수신해도 한 번만 반영 (replay 방어 보강).
  daily_event_id TEXT UNIQUE
);

-- 분위기저해 신고 (보안항목 #5).
-- UNIQUE(session_id, reporter_id, target_member_id) 로 "한 신고자가 같은 대상에게
-- 같은 세션에 중복 신고" 를 DB 레벨에서 차단한다. 코어의 세션당 1회 가산 상한과 별개의 방어선.
CREATE TABLE IF NOT EXISTS disturbance_reports (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  reporter_id TEXT NOT NULL REFERENCES members(id),
  target_member_id TEXT NOT NULL REFERENCES members(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_report_once
    UNIQUE (session_id, reporter_id, target_member_id),
  -- 자기 자신 신고 금지.
  CONSTRAINT no_self_report CHECK (reporter_id <> target_member_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_session_target
  ON disturbance_reports(session_id, target_member_id);

-- 멤버가 직접 신고하는 출결 사유 (기획서 3.3).
-- 세션당 멤버 1건(upsert). OVERTIME/SELF_DEVELOPMENT 는 자동 정당,
-- VAGUE_PERSONAL 은 무단(주 N회 면제), OTHER 는 관리자 승인 시에만 정당.
CREATE TABLE IF NOT EXISTS attendance_reasons (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  member_id   TEXT NOT NULL REFERENCES members(id),
  reason      TEXT NOT NULL
              CHECK (reason IN ('OVERTIME','SELF_DEVELOPMENT','VAGUE_PERSONAL','OTHER','NONE')),
  -- OTHER 사유의 관리자 승인 여부. OTHER 외엔 의미 없음.
  other_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by TEXT REFERENCES members(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, member_id)
);

-- 관리자 설정 (방 단위). 변경은 admin 만 (보안항목 #4).
CREATE TABLE IF NOT EXISTS rule_settings (
  room_id     TEXT PRIMARY KEY,
  settings    JSONB NOT NULL,
  updated_by  TEXT NOT NULL REFERENCES members(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
