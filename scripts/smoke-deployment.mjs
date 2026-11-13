const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base))
  throw new Error("Pass the deployment URL.");
const deadline = AbortSignal.timeout(120000);
const probe = (path) =>
  fetch(base + path, {
    signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
  });
let lastError;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const health = await probe("/api/health");
    const data = await health.json();
    if (!health.ok || data.status !== "ok" || !data.analysisConfigured || !data.transcriptionConfigured)
      throw new Error(
        "Server is unhealthy or Gemini/AssemblyAI configuration is missing.",
      );
    for (const path of ["/", "/record", "/manifest.webmanifest", "/sw.js"]) {
      const response = await probe(path);
      if (!response.ok) throw new Error(path + " returned " + response.status);
    }
    // When MCP is switched on, a deploy is only good if assistants can actually
    // discover and authenticate against it; an unconfigured server skips this.
    if (data.mcpConfigured) {
      const meta = await probe("/.well-known/oauth-authorization-server");
      const issuer = meta.ok && (await meta.json().catch(() => ({}))).issuer;
      if (typeof issuer !== "string" || !issuer.startsWith("http"))
        throw new Error("MCP is configured but the authorization metadata is missing.");
      const resource = await probe("/.well-known/oauth-protected-resource/api/mcp");
      if (!resource.ok) throw new Error("MCP protected resource metadata returned " + resource.status);
      const unauthenticated = await fetch(base + "/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
      });
      if (unauthenticated.status !== 401 || !unauthenticated.headers.get("www-authenticate")?.includes("resource_metadata"))
        throw new Error("MCP endpoint must answer 401 with a pointer to its metadata, got " + unauthenticated.status);
    }
    if (process.env.PROCESSING_QUEUE && !data.processingConfigured)
      throw new Error("Deployment must enable durable server processing.");
    if (process.env.MICROSOFT_CLIENT_ID && !data.microsoftConfigured)
      throw new Error("Deployment must enable the configured Microsoft integration.");
    if (data.microsoftConfigured) {
      const microsoft = await probe('/api/microsoft/config');
      if (!microsoft.ok || !(await microsoft.json()).configured)
        throw new Error('Microsoft configuration is unavailable.');
      const connections = await probe('/api/microsoft/connections');
      if (connections.status !== 401)
        throw new Error('Microsoft connections must require authentication.');
    }
    if (data.processingConfigured) {
      const config = await probe("/api/processing/config");
      if (!config.ok || !(await config.json()).enabled)
        throw new Error("Durable processing configuration is unavailable.");
      const worker = await fetch(base + "/api/processing/worker", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
      });
      if (worker.status !== 401 && worker.status !== 403)
        throw new Error("Processing worker must reject unauthenticated dispatch, got " + worker.status);
    }
    const privateBundle = await probe("/server.cjs");
    if (privateBundle.status !== 404)
      throw new Error("Server bundle is publicly accessible.");
    console.log(
      "Deployment health, Gemini/AssemblyAI configuration, SPA routes, PWA assets and (when enabled) MCP discovery passed.",
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (deadline.aborted) break;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
throw lastError;
