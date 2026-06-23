import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeekSettlement, runAutoExit } from "../../src/api/settlement.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

const S = DEFAULT_SETTINGS;
const WINDOW = { starts_at: "2026-06-22T13:00:00Z", ends_at: "2026-06-22T15:00:00Z" };

/** 한 멤버의 한 주를 "결석 4회"(=벌금)로 만드는 쿼리 묶음을 enqueue. */
function enqueueFinedWeek(fake: FakeQueryable) {
  fake.enqueue([{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }]); // 주 세션 목록
  for (let i = 0; i < 4; i++) {
    fake
      .enqueue([WINDOW]) // session window
      .enqueue([]) // presence 없음 → ABSENT
      .enqueue([]) // reason NONE
      .enqueue([{ n: "0" }]); // disturbance 0
  }
}

/** 한 멤버의 한 주를 "개근"(벌금 0)으로 만드는 묶음. */
function enqueueCleanWeek(fake: FakeQueryable) {
  fake.enqueue([]); // 세션 목록 비어있음 → 결과 없음 → fine 0
}

test("정산: 한 명만 벌금(5000), 참가자 2명 → 1인당 2500", async () => {
  const fake = new FakeQueryable();
  fake.enqueue([{ id: "m1" }, { id: "m2" }]); // 활성 멤버
  enqueueFinedWeek(fake); // m1 벌금
  enqueueCleanWeek(fake); // m2 개근
  const r = await computeWeekSettlement(new Db(fake), S, { mondayDate: "2026-06-22" });
  assert.equal(r.totalFines, S.fineAmount);
  assert.equal(r.participantCount, 2);
  assert.equal(r.perPerson, Math.floor(S.fineAmount / 2));
  assert.deepEqual(r.breakdown, [
    { memberId: "m1", fine: S.fineAmount },
    { memberId: "m2", fine: 0 },
  ]);
});

test("정산: 참가자 0명이어도 0으로 나누지 않음", async () => {
  const fake = new FakeQueryable().enqueue([]); // 활성 멤버 없음
  const r = await computeWeekSettlement(new Db(fake), S, { mondayDate: "2026-06-22" });
  assert.equal(r.totalFines, 0);
  assert.equal(r.perPerson, 0);
});

test("자동퇴장: 연속 4주 벌금이면 EXITED + 비활성화", async () => {
  const fake = new FakeQueryable();
  fake.enqueue([{ id: "m1" }]); // 활성 멤버 1명
  // lookback = 4주, 각 주 벌금(결석 4회) 구성.
  for (let w = 0; w < S.autoExit.exitAfterConsecutiveFineWeeks; w++) {
    enqueueFinedWeek(fake);
  }
  fake.enqueue([], 1); // UPDATE members SET active=FALSE
  const decisions = await runAutoExit(new Db(fake), S, {
    throughMondayDate: "2026-06-22",
  });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "EXITED");
  assert.equal(decisions[0].deactivated, true);
  assert.equal(decisions[0].consecutiveFineWeeks, 4);
  // 마지막 쿼리가 비활성화 UPDATE 인지.
  assert.ok(fake.lastCall.text.includes("UPDATE members SET active = FALSE"));
});

test("자동퇴장: 벌금 주가 없으면 ACTIVE, 비활성화 안 함", async () => {
  const fake = new FakeQueryable();
  fake.enqueue([{ id: "m1" }]);
  for (let w = 0; w < S.autoExit.exitAfterConsecutiveFineWeeks; w++) {
    enqueueCleanWeek(fake); // 매주 개근
  }
  const decisions = await runAutoExit(new Db(fake), S, {
    throughMondayDate: "2026-06-22",
  });
  assert.equal(decisions[0].status, "ACTIVE");
  assert.equal(decisions[0].deactivated, false);
});
