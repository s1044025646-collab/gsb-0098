import http from "node:http";
import { toErrorBody, ApiError } from "./errors.ts";
import type { Ctx } from "./domain/common.ts";
import {
  createApplicant,
  submitRequest,
  requestCorrection,
  receiveCorrection,
  approveExtension,
  listRequestVersions,
  requestView,
} from "./domain/requests.ts";
import { assignSearchTask, completeSearchTask } from "./domain/search.ts";
import { recordReview } from "./domain/review.ts";
import { createResponse, deliverResponse, getResponseDetail } from "./domain/responses.ts";
import { fileReconsideration, decideReconsideration } from "./domain/reconsiderations.ts";
import { getTimeline } from "./domain/timeline.ts";

interface Page {
  limit: number;
  offset: number;
}

function parsePage(url: URL): Page {
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw ApiError.validation("limit must be an integer between 1 and 100");
  if (!Number.isInteger(offset) || offset < 0)
    throw ApiError.validation("offset must be a non-negative integer");
  return { limit, offset };
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("bad shape");
    return parsed;
  } catch {
    throw ApiError.validation("request body must be a JSON object");
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

type Handler = (
  req: http.IncomingMessage,
  url: URL,
  params: Record<string, string>,
  body: Record<string, unknown>,
) => unknown | Promise<unknown>;

export function createServer(ctx: Ctx): http.Server {
  const routes: [string, string, Handler][] = [
    ["GET", "/api/health", () => ({ ok: true })],
    ["POST", "/api/applicants", (_r, _u, _p, b) => createApplicant(ctx, str(b.alias))],
    [
      "POST",
      "/api/requests",
      (_r, _u, _p, b) =>
        submitRequest(ctx, {
          applicantId: str(b.applicantId),
          agencyId: str(b.agencyId),
          scopeText: str(b.scopeText),
          channel: str(b.channel),
          idempotencyKey: b.idempotencyKey === undefined ? undefined : str(b.idempotencyKey),
        }),
    ],
    [
      "GET",
      "/api/requests",
      (_r, url) => {
        const { limit, offset } = parsePage(url);
        const status = url.searchParams.get("status");
        const where = status ? "WHERE status = ?" : "";
        const args = status ? [status] : [];
        const total = (
          ctx.db.prepare(`SELECT COUNT(*) AS c FROM requests ${where}`).get(...args) as { c: number }
        ).c;
        const rows = ctx.db
          .prepare(`SELECT * FROM requests ${where} ORDER BY created_at LIMIT ? OFFSET ?`)
          .all(...args, limit, offset);
        return { total, limit, offset, items: rows };
      },
    ],
    ["GET", "/api/requests/:id", (_r, _u, p) => requestView(ctx, p.id)],
    ["GET", "/api/requests/:id/timeline", (_r, _u, p) => getTimeline(ctx, p.id)],
    ["GET", "/api/requests/:id/versions", (_r, _u, p) => listRequestVersions(ctx, p.id)],
    [
      "POST",
      "/api/requests/:id/corrections",
      (_r, _u, p, b) => requestCorrection(ctx, p.id, str(b.note)),
    ],
    [
      "POST",
      "/api/requests/:id/corrections/received",
      (_r, _u, p, b) => receiveCorrection(ctx, p.id, str(b.scopeText)),
    ],
    [
      "POST",
      "/api/requests/:id/search-tasks",
      (_r, _u, p, b) => assignSearchTask(ctx, p.id, str(b.assignee)),
    ],
    [
      "POST",
      "/api/search-tasks/:id/complete",
      (_r, _u, p, b) =>
        completeSearchTask(ctx, p.id, Array.isArray(b.documentIds) ? (b.documentIds as string[]) : []),
    ],
    [
      "POST",
      "/api/requests/:id/reviews",
      (_r, _u, p, b) =>
        recordReview(ctx, p.id, {
          documentId: str(b.documentId),
          reviewer: str(b.reviewer),
          decision: str(b.decision),
          reason: str(b.reason),
        }),
    ],
    [
      "POST",
      "/api/requests/:id/extensions",
      (_r, _u, p, b) =>
        approveExtension(ctx, p.id, {
          days: Number(b.days),
          reason: str(b.reason),
          approver: str(b.approver),
        }),
    ],
    [
      "POST",
      "/api/requests/:id/responses",
      (_r, _u, p, b) =>
        createResponse(
          ctx,
          p.id,
          { summary: str(b.summary), items: (b.items ?? []) as never },
          { finalize: b.draft !== true },
        ),
    ],
    ["GET", "/api/responses/:id", (_r, _u, p) => getResponseDetail(ctx, p.id)],
    [
      "POST",
      "/api/responses/:id/deliver",
      (_r, _u, p, b) =>
        deliverResponse(ctx, p.id, { channel: str(b.channel), idempotencyKey: str(b.idempotencyKey) }),
    ],
    [
      "POST",
      "/api/requests/:id/reconsiderations",
      (_r, _u, p, b) =>
        fileReconsideration(ctx, p.id, { responseId: str(b.responseId), reason: str(b.reason) }),
    ],
    [
      "POST",
      "/api/reconsiderations/:id/decide",
      (_r, _u, p, b) =>
        decideReconsideration(ctx, p.id, {
          decision: str(b.decision) as "uphold" | "change",
          decisionText: str(b.decisionText),
          newResponse: b.newResponse as never,
        }),
    ],
    [
      "GET",
      "/api/catalog",
      (_r, url) => {
        const { limit, offset } = parsePage(url);
        const agencyId = url.searchParams.get("agencyId");
        const where = agencyId ? "WHERE agency_id = ?" : "";
        const args = agencyId ? [agencyId] : [];
        const total = (
          ctx.db.prepare(`SELECT COUNT(*) AS c FROM documents ${where}`).get(...args) as { c: number }
        ).c;
        const docs = ctx.db
          .prepare(`SELECT * FROM documents ${where} ORDER BY catalog_no LIMIT ? OFFSET ?`)
          .all(...args, limit, offset) as { id: string }[];
        const segStmt = ctx.db.prepare(
          "SELECT id, seq, content FROM document_segments WHERE document_id = ? ORDER BY seq",
        );
        return {
          total,
          limit,
          offset,
          items: docs.map((d) => ({ ...d, segments: segStmt.all(d.id) })),
        };
      },
    ],
  ];

  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(json);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const body = req.method === "POST" ? await readBody(req) : {};
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const pp = pattern.split("/").filter(Boolean);
        if (pp.length !== parts.length) continue;
        const match = pp.every((seg, i) => seg.startsWith(":") || seg === parts[i]);
        if (!match) continue;
        const params: Record<string, string> = {};
        pp.forEach((seg, i) => {
          if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        });
        const result = await handler(req, url, params, body);
        send(200, result);
        return;
      }
      throw ApiError.notFound(`${req.method} ${url.pathname}`);
    } catch (err) {
      const { status, body } = toErrorBody(err);
      send(status, body);
    }
  });
}

export function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}
