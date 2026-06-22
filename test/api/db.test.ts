import { test } from "node:test";
import assert from "node:assert/strict";
import { sql, Db } from "../../src/api/db.ts";
import { FakeQueryable } from "./fakeDb.ts";

test("sql 태그: 보간값은 전부 $n 파라미터로 분리된다", () => {
  const id = "m1";
  const name = "철수";
  const q = sql`SELECT * FROM members WHERE id = ${id} AND display_name = ${name}`;
  assert.equal(
    q.text,
    "SELECT * FROM members WHERE id = $1 AND display_name = $2",
  );
  assert.deepEqual(q.params, ["m1", "철수"]);
});

test("인젝션 시도 문자열도 SQL 이 되지 못하고 값(param)으로만 들어간다", () => {
  const evil = "'; DROP TABLE members; --";
  const q = sql`SELECT * FROM members WHERE id = ${evil}`;
  // 본문엔 플레이스홀더만, 악성 문자열은 텍스트가 아니라 파라미터.
  assert.equal(q.text, "SELECT * FROM members WHERE id = $1");
  assert.deepEqual(q.params, [evil]);
  assert.ok(!q.text.includes("DROP TABLE"));
});

test("보간값이 없으면 파라미터 0개", () => {
  const q = sql`SELECT 1`;
  assert.equal(q.text, "SELECT 1");
  assert.deepEqual(q.params, []);
});

test("Db.run 은 SqlQuery 의 text/params 를 그대로 드라이버에 전달", async () => {
  const fake = new FakeQueryable().enqueue([{ id: "m1" }]);
  const db = new Db(fake);
  const res = await db.run(sql`SELECT * FROM members WHERE id = ${"m1"}`);
  assert.equal(fake.lastCall.text, "SELECT * FROM members WHERE id = $1");
  assert.deepEqual(fake.lastCall.params, ["m1"]);
  assert.equal(res.rowCount, 1);
});

test("Db.one 은 첫 행 또는 null", async () => {
  const fake = new FakeQueryable().enqueue([]).enqueue([{ id: "x" }]);
  const db = new Db(fake);
  assert.equal(await db.one(sql`SELECT 1`), null);
  assert.deepEqual(await db.one(sql`SELECT 1`), { id: "x" });
});
