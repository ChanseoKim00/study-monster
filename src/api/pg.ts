import pg from "pg";
import type { Queryable } from "./db.ts";

// 실제 PostgreSQL 연결 (프로덕션 경로).
//   const pool = createPgPool(config.databaseUrl);
//   const db = new Db(asQueryable(pool));
//   createServer(asQueryable(pool));
// pg.Pool 은 이미 query(text, params) → { rows, rowCount } 를 제공해 Queryable 과 거의 동일하다.
// 다만 pg 의 rowCount 는 number|null 이므로 0 으로 보정해 Queryable 계약을 맞춘다.

export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** pg.Pool(또는 pg 호환 Pool, 예: pg-mem)을 Queryable 로 감싼다. */
export function asQueryable(pool: {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}): Queryable {
  return {
    async query<R = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const res = await pool.query(text, params);
      return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
    },
  };
}
