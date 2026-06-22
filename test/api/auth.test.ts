import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticate,
  requireAdmin,
  requireSelfOrAdmin,
  extractBearer,
  hashToken,
  AuthnError,
  AuthzError,
  type Principal,
} from "../../src/api/auth.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";

test("extractBearer 파싱", () => {
  assert.equal(extractBearer("Bearer abc123"), "abc123");
  assert.equal(extractBearer("bearer abc123"), "abc123");
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer("Token abc"), null);
});

test("토큰은 해시로 조회된다 (평문 토큰이 쿼리에 안 들어감)", async () => {
  const fake = new FakeQueryable().enqueue([
    { member_id: "m1", role: "member", active: true, expires_at: null },
  ]);
  const db = new Db(fake);
  await authenticate(db, "Bearer plaintext-token");
  const params = fake.lastCall.params as string[];
  assert.ok(params.includes(hashToken("plaintext-token")));
  assert.ok(!params.includes("plaintext-token")); // 평문은 안 나감
  assert.ok(fake.lastCall.text.includes("$1")); // 파라미터화
});

test("유효 토큰 → Principal 반환", async () => {
  const fake = new FakeQueryable().enqueue([
    { member_id: "admin1", role: "admin", active: true, expires_at: null },
  ]);
  const p = await authenticate(new Db(fake), "Bearer t");
  assert.deepEqual(p, { memberId: "admin1", role: "admin" });
});

test("토큰 없음/미존재 → AuthnError(401)", async () => {
  const db = new Db(new FakeQueryable());
  await assert.rejects(() => authenticate(db, undefined), AuthnError);
  await assert.rejects(
    () => authenticate(new Db(new FakeQueryable()), "Bearer nope"),
    AuthnError,
  );
});

test("비활성 멤버 / 만료 토큰 거부", async () => {
  const inactive = new FakeQueryable().enqueue([
    { member_id: "m1", role: "member", active: false, expires_at: null },
  ]);
  await assert.rejects(() => authenticate(new Db(inactive), "Bearer t"), AuthnError);

  const expired = new FakeQueryable().enqueue([
    {
      member_id: "m1",
      role: "member",
      active: true,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  ]);
  await assert.rejects(() => authenticate(new Db(expired), "Bearer t"), AuthnError);
});

test("requireAdmin: 관리자만 통과", () => {
  const admin: Principal = { memberId: "a", role: "admin" };
  const member: Principal = { memberId: "m", role: "member" };
  assert.doesNotThrow(() => requireAdmin(admin));
  assert.throws(() => requireAdmin(member), AuthzError);
});

test("requireSelfOrAdmin: 본인 또는 관리자만, 남의 리소스는 차단", () => {
  const member: Principal = { memberId: "m", role: "member" };
  const admin: Principal = { memberId: "a", role: "admin" };
  assert.doesNotThrow(() => requireSelfOrAdmin(member, "m")); // 본인
  assert.doesNotThrow(() => requireSelfOrAdmin(admin, "someone")); // 관리자
  assert.throws(() => requireSelfOrAdmin(member, "other"), AuthzError); // 남
});
