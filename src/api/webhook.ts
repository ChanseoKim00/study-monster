import crypto from "node:crypto";

// Daily webhook 서명 검증 (기획 보안항목 #1 — 이 앱의 핵심 신뢰경계).
//
// 왜 필수인가:
//   출석은 Daily 가 보내는 participant.joined / participant.left 이벤트로 자동 판정된다.
//   서명 검증이 없으면 멤버가 가짜 입장/퇴장 이벤트를 우리 endpoint 로 직접 쏴서
//   자기 출석을 조작할 수 있다. 따라서 "진짜 Daily 가 보낸 요청"임을 HMAC 으로 증명해야 한다.
//
// Daily 서명 스킴 (공식 문서 기준):
//   signedString = `${X-Webhook-Timestamp}.${rawBody}`
//   secret       = base64decode(DAILY_WEBHOOK_SECRET)
//   signature    = base64( HMAC-SHA256(secret, signedString) )
//   → X-Webhook-Signature 헤더 값과 일치해야 한다.
//
// 검증 시 반드시 "수신한 raw body 문자열 그대로" 서명한다.
// JSON 을 파싱 후 재직렬화(JSON.stringify)하면 키 순서/공백이 달라져 서명이 깨진다.

export const TIMESTAMP_HEADER = "x-webhook-timestamp";
export const SIGNATURE_HEADER = "x-webhook-signature";

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: WebhookFailReason };

export type WebhookFailReason =
  | "missing_timestamp"
  | "missing_signature"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance" // replay 방어
  | "signature_mismatch";

export interface VerifyOptions {
  /** base64 인코딩된 webhook 시크릿 (config.dailyWebhookSecret). */
  secret: string;
  /** 허용 타임스탬프 오차(초). 이 범위를 벗어난 과거/미래 요청은 거부. */
  toleranceSeconds: number;
  /** 현재 시각(초, epoch). 테스트 주입용. 기본 Date.now(). */
  nowSeconds?: number;
}

/** HTTP 헤더에서 대소문자 무시하고 단일 값을 꺼낸다. */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  // node http 헤더는 소문자로 정규화되지만, 외부 호출자가 원본 케이스로 줄 수도 있다.
  const target = name.toLowerCase();
  let value = headers[target];
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === target) {
        value = headers[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Daily webhook 요청의 진위를 HMAC 으로 검증한다.
 *
 * @param rawBody  수신한 요청 본문 (반드시 raw 문자열/Buffer, 재직렬화 금지)
 * @param headers  요청 헤더 (x-webhook-timestamp, x-webhook-signature 포함)
 */
export function verifyDailyWebhook(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  options: VerifyOptions,
): WebhookVerifyResult {
  const timestamp = getHeader(headers, TIMESTAMP_HEADER);
  const signature = getHeader(headers, SIGNATURE_HEADER);

  if (!timestamp) return { ok: false, reason: "missing_timestamp" };
  if (!signature) return { ok: false, reason: "missing_signature" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  // replay 방어: 너무 오래되거나 미래인 타임스탬프 거부.
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > options.toleranceSeconds) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const bodyStr =
    typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = computeSignature(timestamp, bodyStr, options.secret);

  if (!timingSafeEqualStr(signature, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

/** Daily 스킴대로 서명 문자열을 계산한다. (테스트/송신 측에서도 재사용) */
export function computeSignature(
  timestamp: string,
  rawBody: string,
  base64Secret: string,
): string {
  const key = Buffer.from(base64Secret, "base64");
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(`${timestamp}.${rawBody}`);
  return hmac.digest("base64");
}

/**
 * 타이밍 공격에 안전한 문자열 비교.
 * 길이가 다르면 즉시 false 지만, crypto.timingSafeEqual 은 길이가 같아야 하므로
 * 길이 불일치 시에도 더미 비교를 수행해 분기 시간차를 최소화한다.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // 길이 노출을 줄이기 위해 동일 길이 더미와 비교 후 false.
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
