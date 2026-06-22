import { test } from "node:test";
import assert from "node:assert/strict";
import {
  submitDisturbanceReport,
  countDistinctReporters,
} from "../../src/api/reports.ts";
import { AuthzError, type Principal } from "../../src/api/auth.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";

const reporter: Principal = { memberId: "r1", role: "member" };

test("새 신고는 기록(recorded), 파라미터 바인딩 사용", async () => {
  const fake = new FakeQueryable().enqueue([], 1); // INSERT 1행
  const out = await submitDisturbanceReport(new Db(fake), reporter, {
    sessionId: "s1",
    targetMemberId: "t1",
  });
  assert.deepEqual(out, { status: "recorded" });
  assert.deepEqual(fake.lastCall.params, ["s1", "r1", "t1"]);
  assert.ok(fake.lastCall.text.includes("ON CONFLICT")); // 중복 차단
});

test("중복 신고는 멱등하게 무시(duplicate) — 연타 어뷰징 무효화", async () => {
  const fake = new FakeQueryable().enqueue([], 0); // ON CONFLICT DO NOTHING
  const out = await submitDisturbanceReport(new Db(fake), reporter, {
    sessionId: "s1",
    targetMemberId: "t1",
  });
  assert.deepEqual(out, { status: "duplicate" });
});

test("자기 자신 신고는 거부(AuthzError) — DB 도달 전 차단", async () => {
  const fake = new FakeQueryable();
  await assert.rejects(
    () =>
      submitDisturbanceReport(new Db(fake), reporter, {
        sessionId: "s1",
        targetMemberId: "r1", // == reporter
      }),
    AuthzError,
  );
  assert.equal(fake.calls.length, 0); // 쿼리조차 안 나감
});

test("countDistinctReporters: 고유 신고자 수 반환", async () => {
  const fake = new FakeQueryable().enqueue([{ n: "3" }]);
  const n = await countDistinctReporters(new Db(fake), {
    sessionId: "s1",
    targetMemberId: "t1",
  });
  assert.equal(n, 3);
  assert.ok(fake.lastCall.text.includes("COUNT(DISTINCT reporter_id)"));
  assert.deepEqual(fake.lastCall.params, ["s1", "t1"]);
});
