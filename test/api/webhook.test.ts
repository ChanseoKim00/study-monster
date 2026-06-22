import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyDailyWebhook,
  computeSignature,
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
} from "../../src/api/webhook.ts";

const SECRET = Buffer.from("super-secret-key").toString("base64");
const NOW = 1_700_000_000; // 고정 epoch(초)

function signedRequest(body: string, ts = NOW, secret = SECRET) {
  const tsStr = String(ts);
  const sig = computeSignature(tsStr, body, secret);
  return {
    body,
    headers: {
      [TIMESTAMP_HEADER]: tsStr,
      [SIGNATURE_HEADER]: sig,
    },
  };
}

const opts = { secret: SECRET, toleranceSeconds: 300, nowSeconds: NOW };

test("진짜 Daily 서명은 통과한다", () => {
  const body = JSON.stringify({ type: "participant.joined", id: "abc" });
  const { headers } = signedRequest(body);
  assert.deepEqual(verifyDailyWebhook(body, headers, opts), { ok: true });
});

test("위조된 body(가짜 입장 이벤트)는 거부 — 핵심 신뢰경계", () => {
  const real = JSON.stringify({ type: "participant.left", id: "abc" });
  const { headers } = signedRequest(real);
  // 공격자가 같은 서명으로 다른 본문을 보냄(출석 조작 시도).
  const forged = JSON.stringify({ type: "participant.joined", id: "abc" });
  const res = verifyDailyWebhook(forged, headers, opts);
  assert.deepEqual(res, { ok: false, reason: "signature_mismatch" });
});

test("틀린 시크릿으로 만든 서명은 거부", () => {
  const body = "{}";
  const wrong = Buffer.from("attacker-secret").toString("base64");
  const { headers } = signedRequest(body, NOW, wrong);
  assert.equal(verifyDailyWebhook(body, headers, opts).ok, false);
});

test("서명/타임스탬프 헤더 누락 거부", () => {
  assert.deepEqual(verifyDailyWebhook("{}", {}, opts), {
    ok: false,
    reason: "missing_timestamp",
  });
  assert.deepEqual(
    verifyDailyWebhook("{}", { [TIMESTAMP_HEADER]: String(NOW) }, opts),
    { ok: false, reason: "missing_signature" },
  );
});

test("replay 방어: 허용 오차 밖의 오래된 타임스탬프 거부", () => {
  const body = "{}";
  const old = NOW - 301; // 5분 + 1초 전
  const { headers } = signedRequest(body, old);
  assert.deepEqual(verifyDailyWebhook(body, headers, opts), {
    ok: false,
    reason: "timestamp_out_of_tolerance",
  });
});

test("replay 방어: 미래 타임스탬프도 거부", () => {
  const body = "{}";
  const future = NOW + 600;
  const { headers } = signedRequest(body, future);
  assert.equal(
    verifyDailyWebhook(body, headers, opts).reason,
    "timestamp_out_of_tolerance",
  );
});

test("허용 오차 안의 약간 과거 요청은 통과", () => {
  const body = "{}";
  const { headers } = signedRequest(body, NOW - 100);
  assert.equal(verifyDailyWebhook(body, headers, opts).ok, true);
});

test("숫자가 아닌 타임스탬프 거부", () => {
  assert.equal(
    verifyDailyWebhook(
      "{}",
      { [TIMESTAMP_HEADER]: "not-a-number", [SIGNATURE_HEADER]: "x" },
      opts,
    ).reason,
    "invalid_timestamp",
  );
});

test("헤더 대소문자 무시", () => {
  const body = "{}";
  const tsStr = String(NOW);
  const sig = computeSignature(tsStr, body, SECRET);
  const headers = {
    "X-Webhook-Timestamp": tsStr,
    "X-Webhook-Signature": sig,
  };
  assert.equal(verifyDailyWebhook(body, headers, opts).ok, true);
});

test("Buffer body 도 동일하게 검증", () => {
  const body = JSON.stringify({ a: 1 });
  const { headers } = signedRequest(body);
  assert.equal(
    verifyDailyWebhook(Buffer.from(body, "utf8"), headers, opts).ok,
    true,
  );
});
