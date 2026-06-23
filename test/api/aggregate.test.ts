import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateSession,
  computeMemberWeek,
  weekRange,
} from "../../src/api/aggregate.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

const S = DEFAULT_SETTINGS;

// aggregateSession 의 쿼리 순서:
// 1) sessions(window) 2) presence_events 3) attendance_reasons 4) disturbance count

test("정시 입장 + 95%+ 체류 → PRESENT, 경고 0", async () => {
  const fake = new FakeQueryable()
    .enqueue([{ starts_at: "2026-06-22T13:00:00Z", ends_at: "2026-06-22T15:00:00Z" }])
    .enqueue([
      { kind: "join", at: "2026-06-22T13:00:00Z" },
      { kind: "leave", at: "2026-06-22T15:00:00Z" },
    ])
    .enqueue([]) // 사유 없음 → NONE
    .enqueue([{ n: "0" }]); // 분위기저해 0
  const r = await aggregateSession(new Db(fake), S, { sessionId: "s1", memberId: "m1" });
  assert.equal(r?.status, "PRESENT");
  assert.equal(r?.warningPoints, 0);
});

test("미입장(이벤트 없음) + 애매한 개인사정 → ABSENT, 1.0점", async () => {
  const fake = new FakeQueryable()
    .enqueue([{ starts_at: "2026-06-22T13:00:00Z", ends_at: "2026-06-22T15:00:00Z" }])
    .enqueue([]) // presence 없음
    .enqueue([{ reason: "VAGUE_PERSONAL", other_approved: false }])
    .enqueue([{ n: "0" }]);
  const r = await aggregateSession(new Db(fake), S, { sessionId: "s1", memberId: "m1" });
  assert.equal(r?.status, "ABSENT");
  assert.equal(r?.warningPoints, S.weights.vagueAbsent);
  assert.equal(r?.isVaguePersonalAbsence, true);
});

test("정상 출석 + 분위기저해 신고 1 → 0.5점 가산", async () => {
  const fake = new FakeQueryable()
    .enqueue([{ starts_at: "2026-06-22T13:00:00Z", ends_at: "2026-06-22T15:00:00Z" }])
    .enqueue([
      { kind: "join", at: "2026-06-22T13:00:00Z" },
      { kind: "leave", at: "2026-06-22T15:00:00Z" },
    ])
    .enqueue([])
    .enqueue([{ n: "1" }]); // 신고 1
  const r = await aggregateSession(new Db(fake), S, { sessionId: "s1", memberId: "m1" });
  assert.equal(r?.warningPoints, S.weights.disturbance);
});

test("야근 사유는 결석이어도 면책(경고 0)", async () => {
  const fake = new FakeQueryable()
    .enqueue([{ starts_at: "2026-06-22T13:00:00Z", ends_at: "2026-06-22T15:00:00Z" }])
    .enqueue([])
    .enqueue([{ reason: "OVERTIME", other_approved: false }])
    .enqueue([{ n: "0" }]);
  const r = await aggregateSession(new Db(fake), S, { sessionId: "s1", memberId: "m1" });
  assert.equal(r?.warningPoints, 0);
  assert.equal(r?.excused, true);
});

test("세션 없으면 null", async () => {
  const fake = new FakeQueryable().enqueue([]);
  const r = await aggregateSession(new Db(fake), S, { sessionId: "x", memberId: "m1" });
  assert.equal(r, null);
});

test("weekRange: KST 월요일 자정 ~ 다음 월요일 자정(UTC로는 일요일 15:00)", () => {
  const { from, to } = weekRange("2026-06-22"); // 월
  assert.equal(from.toISOString(), "2026-06-21T15:00:00.000Z");
  assert.equal(to.toISOString(), "2026-06-28T15:00:00.000Z");
});

test("computeMemberWeek: 무단지각으로 2점 누적되면 벌금 부과", async () => {
  // 세션 2개, 각 10분 지각(LATE 0.5) → 합 1.0... 임계 2.0 미달.
  // 임계 도달을 위해 세션 4개 LATE 로 구성.
  const fake = new FakeQueryable().enqueue([
    { id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" },
  ]);
  // 각 세션마다 aggregateSession 이 4쿼리: window, presence(10분 지각+풀체류),
  // reason(none), disturbance(0)
  for (let i = 0; i < 4; i++) {
    fake
      .enqueue([{ starts_at: "2026-06-22T13:00:00Z", ends_at: "2026-06-22T15:00:00Z" }])
      .enqueue([
        { kind: "join", at: "2026-06-22T13:06:00Z" }, // 6분 지각, 체류 95%(LATE)
        { kind: "leave", at: "2026-06-22T15:00:00Z" },
      ])
      .enqueue([])
      .enqueue([{ n: "0" }]);
  }
  const week = await computeMemberWeek(new Db(fake), S, {
    memberId: "m1",
    mondayDate: "2026-06-22",
  });
  assert.equal(week.totalPoints, 2.0); // 0.5 * 4
  assert.equal(week.reachedThreshold, true);
  assert.equal(week.exempted, false); // 무단지각이라 면제 안 됨
  assert.equal(week.fine, S.fineAmount);
});
