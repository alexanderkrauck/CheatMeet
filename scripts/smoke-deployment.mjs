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
    if (!health.ok || data.status !== "ok" || !data.analysisConfigured)
      throw new Error(
        "Server is unhealthy or the existing Gemini configuration is missing.",
      );
    for (const path of ["/", "/record", "/manifest.webmanifest", "/sw.js"]) {
      const response = await probe(path);
      if (!response.ok) throw new Error(path + " returned " + response.status);
    }
    const privateBundle = await probe("/server.cjs");
    if (privateBundle.status !== 404)
      throw new Error("Server bundle is publicly accessible.");
    console.log(
      "Deployment health, Gemini configuration, SPA routes and PWA assets passed.",
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (deadline.aborted) break;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
throw lastError;
