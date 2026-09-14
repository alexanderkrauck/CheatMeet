import "dotenv/config";
import express from "express";
import path from "node:path";
import { createAnalysisRouter } from "./server/analysis";
import { createAuthRouter } from "./server/googleAuth";
import { createTranscriptionRouter } from "./server/transcription";

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  // Cloud Run terminates TLS at the front end. Without this, req.protocol is
  // always "http", which makes Google reject the OAuth redirect_uri and drops
  // the Secure flag from the CSRF cookie.
  app.set("trust proxy", true);
  app.use("/api", createAuthRouter());
  app.use("/api", createTranscriptionRouter());
  app.use("/api", createAnalysisRouter());
  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      analysisConfigured: Boolean(process.env.GEMINI_API_KEY),
      transcriptionConfigured: Boolean(process.env.ASSEMBLYAI_API_KEY),
    }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API-Endpunkt nicht gefunden." }),
  );

  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use((req, res, next) => {
      // The deployment bundle shares dist with frontend assets but is never public.
      const requestedPath = decodeURIComponent(req.path);
      if (/\.cjs(?:\.map)?$/i.test(requestedPath)) {
        res.sendStatus(404);
        return;
      }
      next();
    });
    app.use(
      express.static(distPath, {
        setHeaders: (res, file) => {
          if (file.endsWith("sw.js") || file.endsWith("index.html"))
            res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    app.get("*", (_req, res) =>
      res.sendFile(path.join(distPath, "index.html")),
    );
  }
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, "0.0.0.0", () =>
    console.log(`CheatMeet running on port ${port}`),
  );
  server.requestTimeout = 5 * 60 * 1000;
}
startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});
