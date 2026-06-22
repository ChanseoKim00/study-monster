import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS as S } from "../src/settings.ts";
import { validateRoomSettings } from "../src/validation.ts";
import type { RuleSettings } from "../src/types.ts";

function withOverrides(o: Partial<RuleSettings>): RuleSettings {
  return { ...S, ...o };
}

test("기본값 + 60분 세션은 지각 충돌이라 막힌다 (95% vs 91.7%)", () => {
  const r = validateRoomSettings(S, 60);
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /지각.*발생할 수 없습니다/);
});

test("체류율을 90%로 낮추면 60분 세션에서 통과", () => {
  const r = validateRoomSettings(withOverrides({ minAttendanceRatio: 0.9 }), 60);
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("정시 기준을 2분으로 줄이면 95% 기준도 통과 (최대 96.7%)", () => {
  const r = validateRoomSettings(withOverrides({ lateGraceMinutes: 2 }), 60);
  assert.equal(r.valid, true);
});

test("90분 세션이면 5분/95% 도 통과 (최대 94.4%... 아니면 막힘)", () => {
  // (90-5)/90 = 94.4% < 95% → 여전히 충돌해야 한다.
  const r = validateRoomSettings(S, 90);
  assert.equal(r.valid, false);
});

test("120분 세션 + 5분/95% → 통과 (최대 95.8%)", () => {
  const r = validateRoomSettings(S, 120);
  assert.equal(r.valid, true);
});

test("체류율 120% 같은 범위 밖 값은 거부", () => {
  const r = validateRoomSettings(withOverrides({ minAttendanceRatio: 1.2 }), 60);
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /0%~100%/);
});

test("정시 기준이 세션보다 길면 거부", () => {
  const r = validateRoomSettings(withOverrides({ lateGraceMinutes: 70 }), 60);
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /짧아야/);
});

test("세션 길이 0은 거부", () => {
  const r = validateRoomSettings(S, 0);
  assert.equal(r.valid, false);
});
