import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppContext } from "../app.ts";
import { DomainError } from "../domain/errors.ts";
import { computeDeadline } from "../domain/deadline.ts";
import { checkCoverage } from "../domain/review.ts";
import { exportTimeline } from "../domain/timeline.ts";
import { seedReferenceData } from "../domain/reference.ts";

interface RouteContext {
  app: AppContext;
  body: unknown;
  query: URLSearchParams;
  params: Record<string, string>;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const names = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, "([^/]+)") + "$");
  return { method, pattern, paramNames: names, handler };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DomainError("VALIDATION_ERROR", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new DomainError("VALIDATION_ERROR", `缺少字段: ${key}`);
    return undefined;
  }
  if (typeof v !== "string") throw new DomainError("VALIDATION_ERROR", `字段 ${key} 必须为字符串`);
  if (required && v.trim() === "") throw new DomainError("VALIDATION_ERROR", `字段 ${key} 不能为空`);
  return v;
}

function int(body: Record<string, unknown>, key: string, required = true): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new DomainError("VALIDATION_ERROR", `缺少字段: ${key}`);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw new DomainError("VALIDATION_ERROR", `字段 ${key} 必须为整数`);
  return v;
}

export function buildRouter(app: AppContext): Route[] {
  return [
    route("POST", "/api/requests", ({ body }) => {
      const b = asObject(body);
      return app.requests.submit({
        agencyId: str(b, "agencyId")!,
        applicantId: str(b, "applicantId")!,
        channelId: str(b, "channelId")!,
        content: str(b, "content")!,
        scopeSummary: str(b, "scopeSummary", false),
        idempotencyKey: str(b, "idempotencyKey", false),
        receivedAt: str(b, "receivedAt", false),
      });
    }),
    route("GET", "/api/requests", ({ query }) =>
      app.requests.list({
        status: query.get("status") ?? undefined,
        applicantId: query.get("applicantId") ?? undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        offset: query.get("offset") ? Number(query.get("offset")) : undefined,
      })
    ),
    route("GET", "/api/requests/:id", ({ params }) => {
      const row = app.db.prepare("SELECT * FROM foi_request WHERE id=?").get(params.id);
      if (!row) throw new DomainError("NOT_FOUND", "申请不存在", 404);
      return row;
    }),
    route("GET", "/api/requests/:id/deadline", ({ params, query }) =>
      computeDeadline(app.db, params.id, query.get("today") ? { today: query.get("today")! } : {})
    ),
    route("GET", "/api/requests/:id/timeline", ({ params, query }) => {
      const tl = exportTimeline(app.db, params.id, query.get("today") ?? undefined);
      if (!tl) throw new DomainError("NOT_FOUND", "申请不存在", 404);
      return tl;
    }),
    route("GET", "/api/requests/:id/coverage", ({ params }) => checkCoverage(app.db, params.id)),

    route("POST", "/api/requests/:id/clarifications", ({ params, body }) => {
      const b = asObject(body);
      return app.clarifications.issue(params.id, str(b, "question")!, int(b, "workdays", false) ?? 7);
    }),
    route("POST", "/api/clarifications/:id/respond", ({ params, body }) => {
      const b = asObject(body);
      return app.clarifications.respond(params.id, str(b, "response")!);
    }),

    route("POST", "/api/requests/:id/searches", ({ params, body }) => {
      const b = asObject(body);
      return app.search.assign(params.id, str(b, "assignee")!, str(b, "note", false) ?? "");
    }),
    route("POST", "/api/searches/:id/complete", ({ params, body }) => {
      const b = asObject(body);
      const items = b.items;
      if (!Array.isArray(items) || items.some((i) => typeof i !== "string"))
        throw new DomainError("VALIDATION_ERROR", "items 必须为字符串数组");
      return app.search.complete(params.id, items);
    }),

    route("POST", "/api/requests/:id/extensions", ({ params, body }) => {
      const b = asObject(body);
      return app.extensions.request(params.id, str(b, "reason")!, int(b, "extraWorkdays")!);
    }),
    route("POST", "/api/extensions/:id/decision", ({ params, body }) => {
      const b = asObject(body);
      const approve = b.approve;
      if (typeof approve !== "boolean") throw new DomainError("VALIDATION_ERROR", "approve 必须为布尔值");
      return app.extensions.decide(params.id, approve, str(b, "approver")!, str(b, "note")!);
    }),

    route("POST", "/api/requests/:id/reviews", ({ params, body }) => {
      const b = asObject(body);
      const disposition = str(b, "disposition")!;
      if (!["public", "redacted", "withheld"].includes(disposition))
        throw new DomainError("VALIDATION_ERROR", "disposition 仅支持 public|redacted|withheld");
      const redaction = b.redaction as { start?: number; end?: number } | undefined;
      return app.reviews.decide(params.id, str(b, "reviewer")!, {
        catalogItemId: str(b, "catalogItemId")!,
        segmentId: str(b, "segmentId", false),
        disposition: disposition as "public" | "redacted" | "withheld",
        legalBasis: str(b, "legalBasis")!,
        reason: str(b, "reason")!,
        redaction:
          redaction !== undefined
            ? { start: Number(redaction.start), end: Number(redaction.end) }
            : undefined,
      });
    }),

    route("POST", "/api/requests/:id/answers", ({ params, body }) => {
      const b = asObject(body);
      return app.answers.generate(params.id, str(b, "issuedBy")!, str(b, "body")!);
    }),
    route("GET", "/api/answers/:id", ({ params }) => app.answers.get(params.id)),
    route("POST", "/api/answers/:id/deliveries", ({ params, body }) => {
      const b = asObject(body);
      return app.answers.deliver(params.id, str(b, "channelId")!, str(b, "idempotencyKey")!);
    }),

    route("POST", "/api/requests/:id/reconsiderations", ({ params, body }) => {
      const b = asObject(body);
      return app.reconsiderations.file(params.id, str(b, "reason")!, str(b, "idempotencyKey", false));
    }),
    route("POST", "/api/reconsiderations/:id/accept", ({ params }) =>
      app.reconsiderations.accept(params.id)
    ),
    route("POST", "/api/reconsiderations/:id/decision", ({ params, body }) => {
      const b = asObject(body);
      const result = str(b, "result")!;
      if (!["upheld", "changed"].includes(result))
        throw new DomainError("VALIDATION_ERROR", "result 仅支持 upheld|changed");
      return app.reconsiderations.decide(
        params.id,
        result as "upheld" | "changed",
        str(b, "body")!,
        str(b, "decidedBy")!
      );
    }),

    route("GET", "/api/catalog", () =>
      app.db
        .prepare(
          `SELECT c.*, (SELECT json_group_array(json_object('id',s.id,'label',s.label,'start',s.start_offset,'end',s.end_offset))
             FROM item_segment s WHERE s.catalog_item_id=c.id) AS segments
           FROM catalog_item c ORDER BY c.id`
        )
        .all()
    ),
    route("POST", "/api/admin/seed", () => {
      seedReferenceData(app.db, app.clock);
      return { seeded: true };
    }),
    route("GET", "/health", () => ({ ok: true, time: app.clock.now().toISOString() })),
  ];
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new DomainError("VALIDATION_ERROR", "请求体过大（上限 1MB）", 413));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new DomainError("VALIDATION_ERROR", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createHttpServer(app: AppContext): Server {
  const routes = buildRouter(app);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return send(200, { name: "foi-local-backend", docs: "/api/requests" });
      const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1]!)));
        const result = await r.handler({ app, body, query: url.searchParams, params });
        return send(200, { data: result });
      }
      return send(404, { error: { code: "NOT_FOUND", message: `无路由: ${req.method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof DomainError) {
        return send(err.httpStatus, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      return send(500, { error: { code: "INTERNAL", message: (err as Error).message } });
    }
  });
}

export function listen(app: AppContext, port = 0, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer(app);
    server.listen(port, host, () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}
