export interface McpConfig {
  /** Public origin, no trailing slash. It is both the OAuth issuer and the base of every URL. */
  issuer: string;
  /** The MCP endpoint; also the audience of every access token. */
  resource: string;
  metadataUrl: string;
  secret: Uint8Array;
  allowedOrigins: string[];
  accessTtlSeconds: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The MCP feature is configured or it is off - never half on. Everything
 * public (issuer, audience, redirect targets) comes from `MCP_PUBLIC_URL`,
 * never from the request's Host header, so a forged Host cannot change what a
 * token is valid for.
 */
export function mcpConfig(env: Record<string, string | undefined> = process.env): McpConfig | null {
  const raw = env.MCP_PUBLIC_URL?.trim();
  const secret = env.MCP_TOKEN_SECRET;
  if (!raw || !secret || Buffer.byteLength(secret) < 32) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  const issuer = url.origin;
  const extra = (env.MCP_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const ttl = Number(env.MCP_ACCESS_TTL_S);
  return {
    issuer,
    resource: `${issuer}/api/mcp`,
    metadataUrl: `${issuer}/.well-known/oauth-protected-resource/api/mcp`,
    secret: new TextEncoder().encode(secret),
    allowedOrigins: [...new Set([issuer, "https://claude.ai", "https://chatgpt.com", ...extra])],
    accessTtlSeconds: Number.isInteger(ttl) && ttl >= 60 && ttl <= 3600 ? ttl : 3600,
  };
}
