import type { Queryable } from "../../src/api/db.ts";

/** 호출을 기록하고 스크립트된 응답을 돌려주는 테스트용 Queryable. */
export class FakeQueryable implements Queryable {
  calls: { text: string; params: unknown[] }[] = [];
  private responses: { rows: unknown[]; rowCount: number }[] = [];

  /** 다음 query 호출들이 순서대로 돌려줄 응답을 큐에 넣는다. */
  enqueue(rows: unknown[], rowCount = rows.length): this {
    this.responses.push({ rows, rowCount });
    return this;
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    this.calls.push({ text, params });
    const res = this.responses.shift() ?? { rows: [], rowCount: 0 };
    return { rows: res.rows as R[], rowCount: res.rowCount };
  }

  get lastCall() {
    return this.calls[this.calls.length - 1];
  }
}
