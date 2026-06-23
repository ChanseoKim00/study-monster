import http from "node:http";
import { Db, type Queryable } from "./db.ts";
import { loadConfig, redactConfig } from "./config.ts";
import {
  handleDailyWebhook,
  handleUpdateSettings,
  handleForceExit,
  handleSubmitReport,
  handleDeclareReason,
  handleApproveReason,
  handleWeeklyStatus,
  handleSettlement,
  handleRunAutoExit,
  type Ctx,
  type HttpRequest,
  type HttpResponse,
} from "./handlers.ts";

// node http 어댑터. 핸들러는 프레임워크 비종속이라 Next.js 로도 동일하게 끼울 수 있다.
//
// 중요: webhook 서명 검증을 위해 본문을 "raw 문자열" 그대로 핸들러에 넘긴다.
//       JSON 미들웨어가 파싱/재직렬화하기 전에 raw 를 잡아야 서명이 깨지지 않는다.

/** 요청 본문 최대 크기(바이트). 초과 시 거부해 메모리 고갈(DoS)을 막는다. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB — webhook/JSON 페이로드엔 충분

class PayloadTooLargeError extends Error {}

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 단순 라우팅: 핸들러 레이어로 위임. (경로 파라미터는 정규식으로 추출) */
async function route(ctx: Ctx, hreq: HttpRequest): Promise<HttpResponse> {
  const { method, path } = hreq;

  if (method === "POST" && path === "/webhooks/daily") {
    return handleDailyWebhook(ctx, hreq);
  }
  if (method === "POST" && path === "/reports/disturbance") {
    return handleSubmitReport(ctx, hreq);
  }
  if (method === "POST" && path === "/reasons") {
    return handleDeclareReason(ctx, hreq);
  }
  if (method === "POST" && path === "/admin/reasons/approve") {
    return handleApproveReason(ctx, hreq);
  }
  let m = /^\/admin\/rooms\/([^/]+)\/settings$/.exec(path);
  if (method === "PUT" && m) {
    return handleUpdateSettings(ctx, hreq, {
      roomId: decodeURIComponent(m[1]),
      // 세션 길이는 방 정보에서 와야 하지만, 어댑터 단순화를 위해 헤더로 받는다.
      sessionDurationMinutes:
        Number(hreq.headers["x-session-duration"] as string) || 60,
    });
  }
  m = /^\/admin\/members\/([^/]+)\/exit$/.exec(path);
  if (method === "POST" && m) {
    return handleForceExit(ctx, hreq, { memberId: decodeURIComponent(m[1]) });
  }
  const q = hreq.query ?? {};
  if (method === "GET" && path === "/weekly") {
    return handleWeeklyStatus(ctx, hreq, {
      memberId: q.memberId ?? "",
      mondayDate: q.mondayDate ?? "",
      roomId: q.roomId,
    });
  }
  if (method === "GET" && path === "/admin/settlement") {
    return handleSettlement(ctx, hreq, {
      mondayDate: q.mondayDate ?? "",
      roomId: q.roomId,
    });
  }
  if (method === "POST" && path === "/admin/auto-exit/run") {
    return handleRunAutoExit(ctx, hreq, {
      throughMondayDate: q.mondayDate ?? "",
      roomId: q.roomId,
    });
  }
  return { status: 404, body: { error: "not found" } };
}

/** Queryable(예: pg.Pool)을 주입해 http 서버를 만든다. */
export function createServer(pool: Queryable): http.Server {
  const config = loadConfig();
  const ctx: Ctx = { db: new Db(pool), config };
  // 기동 로그엔 시크릿 값 대신 set/missing 만.
  console.log("config:", redactConfig(config));

  return http.createServer(async (req, res) => {
    try {
      const rawBody = await readRawBody(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      const hreq: HttpRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        headers: req.headers,
        rawBody,
        query: Object.fromEntries(url.searchParams),
      };
      const result = await route(ctx, hreq);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (e) {
      const status = e instanceof PayloadTooLargeError ? 413 : 500;
      const error = status === 413 ? "요청 본문이 너무 큽니다." : "내부 오류";
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error }));
    }
  });
}
