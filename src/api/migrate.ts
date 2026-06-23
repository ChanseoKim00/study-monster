import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "./db.ts";

// 스키마 마이그레이션 러너. schema.sql 을 그대로 실행한다.
// (CREATE TABLE IF NOT EXISTS 라 반복 실행해도 안전 — 멱등)

const SCHEMA_PATH = path.resolve(fileURLToPath(import.meta.url), "../schema.sql");

export async function readSchema(): Promise<string> {
  return fs.readFile(SCHEMA_PATH, "utf8");
}

/** 주입된 DB(pg.Pool 또는 호환)에 스키마를 적용한다. */
export async function migrate(db: Queryable): Promise<void> {
  const schema = await readSchema();
  await db.query(schema);
}
