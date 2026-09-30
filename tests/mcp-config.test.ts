import { describe, expect, it } from "vitest";
import { mcpConfig } from "../server/mcp/config";

const SECRET = "a".repeat(40);
const good = { MCP_PUBLIC_URL: "https://cheatmeet.example.com", MCP_TOKEN_SECRET: SECRET };

describe("mcpConfig", () => {
  it("is off unless both the public URL and a secret are set", () => {
    expect(mcpConfig({})).toBeNull();
    expect(mcpConfig({ MCP_PUBLIC_URL: good.MCP_PUBLIC_URL })).toBeNull();
    expect(mcpConfig({ MCP_TOKEN_SECRET: SECRET })).toBeNull();
  });

  it("refuses a secret shorter than 32 bytes", () => {
    expect(mcpConfig({ ...good, MCP_TOKEN_SECRET: "short" })).toBeNull();
  });

  it("derives issuer, resource and endpoints from the public URL, without a trailing slash", () => {
    const config = mcpConfig({ ...good, MCP_PUBLIC_URL: "https://cheatmeet.example.com/" })!;
    expect(config.issuer).toBe("https://cheatmeet.example.com");
    expect(config.resource).toBe("https://cheatmeet.example.com/api/mcp");
    expect(config.metadataUrl).toBe("https://cheatmeet.example.com/.well-known/oauth-protected-resource/api/mcp");
  });

  it("only accepts https, except for loopback", () => {
    expect(mcpConfig({ ...good, MCP_PUBLIC_URL: "http://cheatmeet.example.com" })).toBeNull();
    expect(mcpConfig({ ...good, MCP_PUBLIC_URL: "http://localhost:3000" })).not.toBeNull();
    expect(mcpConfig({ ...good, MCP_PUBLIC_URL: "http://127.0.0.1:3000" })).not.toBeNull();
    expect(mcpConfig({ ...good, MCP_PUBLIC_URL: "javascript:alert(1)" })).toBeNull();
    expect(mcpConfig({ ...good, MCP_PUBLIC_URL: "not a url" })).toBeNull();
  });

  it("rejects a public URL that carries a path, query or fragment", () => {
    for (const url of ["https://x.example/app", "https://x.example/?a=1", "https://x.example/#f"])
      expect(mcpConfig({ ...good, MCP_PUBLIC_URL: url }), url).toBeNull();
  });

  it("allows the app's own origin plus the two hosted assistants, and whatever is configured", () => {
    const defaults = mcpConfig(good)!.allowedOrigins;
    expect(defaults).toEqual(expect.arrayContaining(["https://cheatmeet.example.com", "https://claude.ai", "https://chatgpt.com"]));
    const extra = mcpConfig({ ...good, MCP_ALLOWED_ORIGINS: " https://a.example , https://b.example " })!.allowedOrigins;
    expect(extra).toEqual(expect.arrayContaining(["https://a.example", "https://b.example"]));
  });

  it("keeps the access-token lifetime between 60 seconds and an hour", () => {
    expect(mcpConfig(good)!.accessTtlSeconds).toBe(3600);
    expect(mcpConfig({ ...good, MCP_ACCESS_TTL_S: "120" })!.accessTtlSeconds).toBe(120);
    expect(mcpConfig({ ...good, MCP_ACCESS_TTL_S: "5" })!.accessTtlSeconds).toBe(3600);
    expect(mcpConfig({ ...good, MCP_ACCESS_TTL_S: "999999" })!.accessTtlSeconds).toBe(3600);
    expect(mcpConfig({ ...good, MCP_ACCESS_TTL_S: "abc" })!.accessTtlSeconds).toBe(3600);
  });

  it("hands out the secret as bytes for signing", () => {
    expect(mcpConfig(good)!.secret).toBeInstanceOf(Uint8Array);
    expect(mcpConfig(good)!.secret.length).toBe(40);
  });
});
