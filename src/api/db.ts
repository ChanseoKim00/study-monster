// SQL 파라미터 바인딩 레이어 (기획 보안항목 #3 — SQL 인젝션 방지).
//
// 원칙: 쿼리 문자열에 사용자 입력을 절대 직접 이어붙이지 않는다.
//       모든 값은 $1, $2 ... 플레이스홀더로 분리해 드라이버가 바인딩하게 한다.
//
// 이를 "관습"이 아니라 "구조적으로" 강제하기 위해 sql 태그드 템플릿을 제공한다.
//   sql`SELECT * FROM members WHERE id = ${id}`
//     → { text: "SELECT * FROM members WHERE id = $1", params: [id] }
// 템플릿 보간으로 들어온 값은 절대 SQL 텍스트가 될 수 없고, 항상 파라미터가 된다.
// 따라서 `"... WHERE name = '" + name + "'"` 같은 인젝션 가능한 조합 자체가 불가능하다.

/** 파라미터화된 쿼리. text 에는 $1.. 플레이스홀더만, 값은 params 에. */
export interface SqlQuery {
  text: string;
  params: unknown[];
}

/**
 * 안전한 파라미터화 쿼리를 만드는 태그드 템플릿.
 * 보간값은 전부 params 로 빠지고 본문엔 $n 플레이스홀더만 남는다.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlQuery {
  let text = "";
  const params: unknown[] = [];
  strings.forEach((chunk, i) => {
    text += chunk;
    if (i < values.length) {
      params.push(values[i]);
      text += `$${params.length}`;
    }
  });
  return { text, params };
}

/**
 * pg.Pool 호환 최소 인터페이스.
 * 실제 배포에선 `new Pool({ connectionString: config.databaseUrl })` 를 주입한다.
 * (드라이버는 $n 파라미터 바인딩을 네이티브로 지원 → 인젝션 차단)
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

/**
 * Queryable 을 감싸 SqlQuery 만 받도록 강제하는 래퍼.
 * 호출부가 raw 문자열을 직접 넘길 수 없게 해, 항상 파라미터화 경로를 타게 한다.
 */
export class Db {
  private readonly pool: Queryable;

  constructor(pool: Queryable) {
    this.pool = pool;
  }

  async run<R = Record<string, unknown>>(
    query: SqlQuery,
  ): Promise<{ rows: R[]; rowCount: number }> {
    return this.pool.query<R>(query.text, query.params);
  }

  async one<R = Record<string, unknown>>(
    query: SqlQuery,
  ): Promise<R | null> {
    const { rows } = await this.run<R>(query);
    return rows[0] ?? null;
  }
}
