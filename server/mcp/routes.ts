import express, { type Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import firebaseConfig from "../../firebase-applet-config.json";
import type { LiveDoc } from "../../shared/mcp";
import { verifyFirebaseToken } from "../analysis";
import { googleAccountFor, refreshAccessToken } from "../googleAuth";
import { fileGrantStore, firestoreStore, serviceAccountToken, type RefreshTokenStore } from "../tokenStore";
import { mcpConfig, type McpConfig } from "./config";
import { fileDocStore, firestoreDocStore, memoryDocStore, type DocStore } from "./docStore";
import { createMcpRouter } from "./index";
import { createLiveRouter } from "./live";
import { driveTranscriptReader, firestoreReportIndex } from "./meetings";
import { createOAuthRouter, type Grant } from "./oauth";

const run = promisify(execFile);
const exec = (file: string, args: string[]) => run(file, args, { timeout: 10_000 });

/**
 * Local development has no Cloud Run metadata server. `MCP_DEV_ADC=1` borrows
 * the developer's own gcloud login instead - which means the dev server then
 * reads REAL Firestore data. Refused in production, and the command is fixed:
 * nothing from the environment is ever executed.
 */
function devAdcToken(): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const { stdout } = await exec("gcloud", ["auth", "application-default", "print-access-token"]);
    const token = stdout.trim();
    if (!token) throw new Error("gcloud returned no token");
    cached = { token, until: Date.now() + 50 * 60_000 };
    return token;
  };
}

export interface McpRoutes {
  /** Mounted at the site root: the well-known documents live outside /api. */
  root: Router;
  /** Mounted under /api. */
  api: Router;
  enabled: boolean;
}

export function createMcpRoutes(env: Record<string, string | undefined> = process.env): McpRoutes {
  const config: McpConfig | null = mcpConfig(env);
  if (!config) return { root: createMcpRouter(null), api: express.Router(), enabled: false };

  const production = env.NODE_ENV === "production";
  const projectId = env.FIREBASE_PROJECT_ID || firebaseConfig.projectId;
  const databaseId = (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId || "(default)";
  const useFirestore = production || env.MCP_DEV_ADC === "1";
  if (!production && env.MCP_DEV_ADC === "1") console.warn("MCP_DEV_ADC=1: reading and writing real Firestore with your gcloud login.");
  const token = production ? () => serviceAccountToken(fetch) : devAdcToken();

  const store = <T>(collection: string, devDir: string): DocStore<T> =>
    useFirestore
      ? firestoreDocStore<T>({ collection, projectId, databaseId, fetchImpl: fetch, token })
      : env.MCP_DEV_MEMORY === "1" ? memoryDocStore<T>() : fileDocStore<T>(path.resolve(devDir));
  const grants = store<Grant>("mcpGrants", ".mcp-grants");
  const live = store<LiveDoc>("mcpLive", ".mcp-live");

  const clientId = env.GOOGLE_OAUTH_CLIENT_ID || (firebaseConfig as { oAuthClientId?: string }).oAuthClientId || "";
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const driveRefreshTokens: RefreshTokenStore = production ? firestoreStore({ fetchImpl: fetch }) : fileGrantStore();

  const identify = (idToken: string) => googleAccountFor(idToken, projectId);
  const oauth = createOAuthRouter({
    config,
    store: grants,
    identify,
    hasDriveGrant: async (googleSub) => Boolean(await driveRefreshTokens.get(googleSub).catch(() => null)),
  });
  const mcp = createMcpRouter({
    config,
    grants,
    live,
    index: firestoreReportIndex({ projectId, databaseId, fetchImpl: fetch, token }),
    transcripts: driveTranscriptReader({
      refreshToken: (googleSub) => driveRefreshTokens.get(googleSub),
      mint: (refreshToken) => refreshAccessToken({ refreshToken, clientId, clientSecret }),
      fetchImpl: fetch,
    }),
  });
  const root = express.Router();
  root.use(oauth);
  root.use(mcp);
  return {
    root,
    api: createLiveRouter({ grants, live, verifyToken: verifyFirebaseToken }),
    enabled: true,
  };
}
