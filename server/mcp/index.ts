import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { originValidation, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { LiveDoc } from "../../shared/mcp";
import type { McpConfig } from "./config";
import type { DocStore } from "./docStore";
import type { MeetingIndex, TranscriptReader } from "./meetings";
import { verifyAccessToken, type Grant } from "./oauth";
import { buildServer } from "./tools";

export interface McpDeps {
  config: McpConfig;
  grants: DocStore<Grant>;
  live: DocStore<LiveDoc>;
  index: MeetingIndex;
  transcripts: TranscriptReader;
  now?: () => number;
}

/**
 * `POST /api/mcp`: stateless Streamable HTTP. No session is kept between
 * requests, so any instance can answer any call - and a restart loses nothing.
 * When the feature is not configured the route answers 503 instead of
 * disappearing, so a client sees a reason rather than a 404.
 */
export function createMcpRouter(deps: McpDeps | null): Router {
  const router = express.Router();
  if (!deps) {
    router.all("/api/mcp", (_req, res) =>
      res.status(503).json({ error: "Der MCP-Zugriff ist noch nicht eingerichtet." }),
    );
    return router;
  }
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const bearer = requireBearerAuth({
    verifier: { verifyAccessToken: (token) => verifyAccessToken(token, { config, store: deps.grants, now }) },
    resourceMetadataUrl: config.metadataUrl,
  });
  const origins = originValidation(config.allowedOrigins.map((origin) => new URL(origin).hostname));

  const handler = createMcpHandler(
    (context) => buildServer({ index: deps.index, transcripts: deps.transcripts, live: deps.live, now }, context.authInfo as AuthInfo | undefined),
    { legacy: "stateless", responseMode: "json" },
  );
  const serve = toNodeHandler(handler, {
    maxRequestBodySize: 64 * 1024,
    onerror: (error) => console.error("MCP handler error:", error.message),
  });

  // Browsers only: an Origin that is present but not ours is refused; clients that
  // are not browsers send none. (The DNS-rebinding guard for Host is the proxy's job.)
  const guardOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.origin) return next();
    return origins(req, res, next);
  };
  router.all("/api/mcp", guardOrigin, bearer, (req: Request, res: Response) => {
    void serve(req, res);
  });
  return router;
}
