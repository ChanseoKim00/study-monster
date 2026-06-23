import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declareReason,
  approveOtherReason,
  getReason,
} from "../../src/api/reasons.ts";
import { AuthzError, type Principal } from "../../src/api/auth.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";

const member: Principal = { memberId: "m1", role: "member" };
const admin: Principal = { memberId: "a1", role: "admin" };

test("본인 사유 신고는 upsert, other_approved 초기화", async () => {
  const fake = new FakeQueryable().enqueue([], 1);
  const out = await declareReason(new Db(fake), member, {
    sessionId: "s1",
    memberId: "m1",
    reason: "VAGUE_PERSONAL",
  });
  assert.deepEqual(out, { reason: "VAGUE_PERSONAL" });
  assert.deepEqual(fake.lastCall.params, ["s1", "m1", "VAGUE_PERSONAL"]);
  assert.ok(fake.lastCall.text.includes("other_approved = FALSE"));
});

test("남의 사유 신고는 거부 (관리자라도 대리 신고 불가)", async () => {
  const fake = new FakeQueryable();
  await assert.rejects(
    () => declareReason(new Db(fake), member, { sessionId: "s1", memberId: "other", reason: "OTHER" }),
    AuthzError,
  );
  await assert.rejects(
    () => declareReason(new Db(fake), admin, { sessionId: "s1", memberId: "m1", reason: "OTHER" }),
    AuthzError,
  );
  assert.equal(fake.calls.length, 0);
});

test("알 수 없는 사유 카테고리 거부", async () => {
  const fake = new FakeQueryable();
  await assert.rejects(
    () => declareReason(new Db(fake), member, { sessionId: "s1", memberId: "m1", reason: "HOLIDAY" }),
    AuthzError,
  );
});

test("OTHER 승인은 관리자만, OTHER 행에만 적용", async () => {
  const fake = new FakeQueryable().enqueue([], 1);
  const ok = await approveOtherReason(new Db(fake), admin, { sessionId: "s1", memberId: "m1" });
  assert.equal(ok, true);
  assert.ok(fake.lastCall.text.includes("reason = 'OTHER'"));
  assert.deepEqual(fake.lastCall.params, ["a1", "s1", "m1"]);
});

test("멤버는 OTHER 승인 불가 (AuthzError)", async () => {
  const fake = new FakeQueryable();
  await assert.rejects(
    () => approveOtherReason(new Db(fake), member, { sessionId: "s1", memberId: "m1" }),
    AuthzError,
  );
  assert.equal(fake.calls.length, 0);
});

test("승인 대상 없으면 false", async () => {
  const fake = new FakeQueryable().enqueue([], 0);
  const ok = await approveOtherReason(new Db(fake), admin, { sessionId: "s1", memberId: "m1" });
  assert.equal(ok, false);
});

test("getReason: 없으면 NONE/미승인", async () => {
  const fake = new FakeQueryable().enqueue([]);
  assert.deepEqual(await getReason(new Db(fake), { sessionId: "s1", memberId: "m1" }), {
    reason: "NONE",
    otherApproved: false,
  });
});

test("getReason: 있으면 그대로", async () => {
  const fake = new FakeQueryable().enqueue([{ reason: "OTHER", other_approved: true }]);
  assert.deepEqual(await getReason(new Db(fake), { sessionId: "s1", memberId: "m1" }), {
    reason: "OTHER",
    otherApproved: true,
  });
});
