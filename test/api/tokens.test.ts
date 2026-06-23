import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateToken,
  createMember,
  issueToken,
  revokeToken,
  seedAdminIfNone,
  bootstrapAdmin,
} from "../../src/api/tokens.ts";
import { hashToken } from "../../src/api/auth.ts";
import { Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";

test("generateToken: 매번 다른 고엔트로피 토큰", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40); // 32바이트 base64url
});

test("issueToken: DB 엔 평문이 아니라 해시만 저장, 평문은 반환", async () => {
  const fake = new FakeQueryable().enqueue([], 1);
  const token = await issueToken(new Db(fake), "m1");
  const params = fake.lastCall.params as unknown[];
  assert.ok(params.includes(hashToken(token)));
  assert.ok(!params.includes(token)); // 평문 미저장
  assert.ok(fake.lastCall.text.includes("INSERT INTO auth_tokens"));
});

test("createMember: 파라미터 바인딩 + 기본 role member", async () => {
  const fake = new FakeQueryable().enqueue([], 1);
  await createMember(new Db(fake), { id: "m1", displayName: "철수" });
  assert.deepEqual(fake.lastCall.params, ["m1", "철수", "member"]);
});

test("revokeToken: 해시로 삭제", async () => {
  const fake = new FakeQueryable().enqueue([], 1);
  const ok = await revokeToken(new Db(fake), "plain");
  assert.equal(ok, true);
  assert.deepEqual(fake.lastCall.params, [hashToken("plain")]);
});

test("seedAdminIfNone: 관리자 없으면 생성+토큰 발급", async () => {
  const fake = new FakeQueryable()
    .enqueue([{ n: "0" }]) // 관리자 0명
    .enqueue([], 1) // createMember
    .enqueue([], 1); // issueToken
  const token = await seedAdminIfNone(new Db(fake), { id: "a1", displayName: "관리자" });
  assert.ok(token && token.length > 0);
});

test("seedAdminIfNone: 이미 관리자 있으면 null (중복 생성 안 함)", async () => {
  const fake = new FakeQueryable().enqueue([{ n: "1" }]);
  const token = await seedAdminIfNone(new Db(fake), { id: "a2", displayName: "x" });
  assert.equal(token, null);
  assert.equal(fake.calls.length, 1); // COUNT 만
});

test("bootstrapAdmin: ADMIN_BOOTSTRAP_ID 없으면 아무것도 안 함", async () => {
  const fake = new FakeQueryable();
  const r = await bootstrapAdmin(new Db(fake), {});
  assert.deepEqual(r, { created: false });
  assert.equal(fake.calls.length, 0); // DB 접근 없음
});

test("bootstrapAdmin: ID 있고 관리자 없으면 생성 + 토큰", async () => {
  const fake = new FakeQueryable()
    .enqueue([{ n: "0" }]) // 관리자 0명
    .enqueue([], 1) // createMember
    .enqueue([], 1); // issueToken
  const r = await bootstrapAdmin(new Db(fake), { ADMIN_BOOTSTRAP_ID: "admin", ADMIN_BOOTSTRAP_NAME: "관리자" });
  assert.equal(r.created, true);
  assert.equal(r.memberId, "admin");
  assert.ok(r.token && r.token.length > 0);
});

test("bootstrapAdmin: 관리자 이미 있으면 created=false (멱등)", async () => {
  const fake = new FakeQueryable().enqueue([{ n: "1" }]);
  const r = await bootstrapAdmin(new Db(fake), { ADMIN_BOOTSTRAP_ID: "admin" });
  assert.deepEqual(r, { created: false });
});
