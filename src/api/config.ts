// 시크릿/환경설정 로더.
//
// 보안 원칙 (기획 보안항목 #2):
//   - DB URL · Daily API 키 · webhook secret · 관리자 토큰은 절대 코드/깃에 넣지 않는다.
//     전부 Railway 환경변수(process.env)에서만 읽는다. (.gitignore 에 .env 포함됨)
//   - 필수 시크릿이 없으면 "조용히 빈 값으로" 동작하지 않고 즉시 기동을 실패시킨다.
//     (빈 secret 으로 webhook 검증을 통과시키는 사고를 원천 차단)
//   - 시크릿 값 자체는 절대 로그/에러 메시지에 담지 않는다. 키 '이름'만 노출한다.

/** 앱이 신뢰경계를 지키기 위해 반드시 필요한 시크릿/설정. */
export interface AppConfig {
  /** PostgreSQL 연결 문자열. (Railway 가 주입) */
  databaseUrl: string;
  /** Daily REST API 호출용 키. */
  dailyApiKey: string;
  /** Daily webhook HMAC 검증용 base64 시크릿. */
  dailyWebhookSecret: string;
  /** webhook 타임스탬프 허용 오차(초). replay 방어. 기본 300s(5분). */
  webhookToleranceSeconds: number;
  /** 멤버가 접속할 Daily room URL. 선택 — 없으면 화상 화면 비활성. */
  dailyRoomUrl?: string;
}

/** 필수 키 목록 — 하나라도 비면 기동 실패. */
const REQUIRED_KEYS = [
  "DATABASE_URL",
  "DAILY_API_KEY",
  "DAILY_WEBHOOK_SECRET",
] as const;

/** 시크릿 값을 절대 노출하지 않기 위해, 메시지엔 키 이름만 쓴다. */
export class ConfigError extends Error {
  constructor(missingKeys: string[]) {
    super(
      `필수 환경변수가 설정되지 않았습니다: ${missingKeys.join(", ")}. ` +
        `Railway 환경변수에 설정하세요. (코드/깃에 직접 넣지 마세요.)`,
    );
    this.name = "ConfigError";
  }
}

/**
 * process.env(또는 주입된 env)에서 설정을 로드한다.
 * 필수 시크릿이 비어 있으면 ConfigError 를 던져 기동을 막는다.
 *
 * 테스트 용이성을 위해 env 를 주입받지만, 기본은 process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = REQUIRED_KEYS.filter((k) => {
    const v = env[k];
    return v === undefined || v.trim() === "";
  });
  if (missing.length > 0) {
    throw new ConfigError(missing);
  }

  const toleranceRaw = env.WEBHOOK_TOLERANCE_SECONDS;
  let webhookToleranceSeconds = 300;
  if (toleranceRaw !== undefined && toleranceRaw.trim() !== "") {
    const parsed = Number(toleranceRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        "WEBHOOK_TOLERANCE_SECONDS 는 양수여야 합니다.",
      );
    }
    webhookToleranceSeconds = parsed;
  }

  const dailyRoomUrl = env.DAILY_ROOM_URL?.trim();

  return {
    // non-null 단언: 위에서 missing 검사를 통과했으므로 존재가 보장된다.
    databaseUrl: env.DATABASE_URL!,
    dailyApiKey: env.DAILY_API_KEY!,
    dailyWebhookSecret: env.DAILY_WEBHOOK_SECRET!,
    webhookToleranceSeconds,
    dailyRoomUrl: dailyRoomUrl || undefined,
  };
}

/**
 * 로그/디버그 출력용 안전한 설정 요약.
 * 시크릿 값은 절대 포함하지 않고, "설정됨/미설정" 여부만 노출한다.
 */
export function redactConfig(config: AppConfig): Record<string, string> {
  const present = (v: string) => (v && v.length > 0 ? "set" : "missing");
  return {
    DATABASE_URL: present(config.databaseUrl),
    DAILY_API_KEY: present(config.dailyApiKey),
    DAILY_WEBHOOK_SECRET: present(config.dailyWebhookSecret),
    WEBHOOK_TOLERANCE_SECONDS: String(config.webhookToleranceSeconds),
    DAILY_ROOM_URL: config.dailyRoomUrl ? "set" : "missing",
  };
}
