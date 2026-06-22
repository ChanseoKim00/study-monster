import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, redactConfig, ConfigError } from "../../src/api/config.ts";

const full = {
  DATABASE_URL: "postgres://localhost/db",
  DAILY_API_KEY: "key-123",
  DAILY_WEBHOOK_SECRET: "c2VjcmV0", // base64
};

test("필수 시크릿이 모두 있으면 로드 성공", () => {
  const c = loadConfig({ ...full });
  assert.equal(c.databaseUrl, "postgres://localhost/db");
  assert.equal(c.dailyApiKey, "key-123");
  assert.equal(c.dailyWebhookSecret, "c2VjcmV0");
  assert.equal(c.webhookToleranceSeconds, 300); // 기본값
});

test("필수 시크릿 누락 시 기동 실패(ConfigError)", () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: "x" }),
    (e: unknown) =>
      e instanceof ConfigError &&
      e.message.includes("DAILY_API_KEY") &&
      e.message.includes("DAILY_WEBHOOK_SECRET"),
  );
});

test("빈 문자열/공백 시크릿도 누락으로 취급", () => {
  assert.throws(
    () => loadConfig({ ...full, DAILY_WEBHOOK_SECRET: "   " }),
    ConfigError,
  );
});

test("에러 메시지에 시크릿 '값'은 절대 노출하지 않는다", () => {
  try {
    loadConfig({ ...full, DAILY_API_KEY: "" });
    assert.fail("던졌어야 함");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes("key-123"));
    assert.ok(!msg.includes("c2VjcmV0"));
    assert.ok(msg.includes("DAILY_API_KEY")); // 키 이름만
  }
});

test("redactConfig 는 값 대신 set/missing 만 노출", () => {
  const c = loadConfig({ ...full });
  const r = redactConfig(c);
  assert.equal(r.DAILY_WEBHOOK_SECRET, "set");
  assert.ok(!JSON.stringify(r).includes("c2VjcmV0"));
});

test("WEBHOOK_TOLERANCE_SECONDS 양수 파싱, 잘못된 값은 거부", () => {
  assert.equal(
    loadConfig({ ...full, WEBHOOK_TOLERANCE_SECONDS: "120" })
      .webhookToleranceSeconds,
    120,
  );
  assert.throws(() =>
    loadConfig({ ...full, WEBHOOK_TOLERANCE_SECONDS: "-5" }),
  );
});
