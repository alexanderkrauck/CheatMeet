import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import { createHash } from "node:crypto";
import path from "path";
import { defineConfig, Plugin } from "vite";

// LINT.IfChange(aistudio_media_plugin)
function aistudioMediaPlugin(): Plugin {
  return {
    name: "vite-plugin-aistudio-media",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/assets/aistudio/")) {
          const rawPath = req.url.split("?")[0].split("#")[0];
          try {
            const decodedPath = decodeURIComponent(rawPath);
            const relativePath = decodedPath.replace(/^\//, "");
            const aistudioDir = path.resolve(
              __dirname,
              "public",
              "assets",
              "aistudio",
            );
            const filePath = path.resolve(__dirname, "public", relativePath);
            if (
              filePath.startsWith(aistudioDir + path.sep) &&
              fs.existsSync(filePath) &&
              fs.statSync(filePath).isFile()
            ) {
              const ext = path.extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".png": "image/png",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
                ".bmp": "image/bmp",
                ".ico": "image/x-icon",
                ".mp4": "video/mp4",
                ".webm": "video/webm",
                ".ogv": "video/ogg",
                ".mp3": "audio/mpeg",
                ".wav": "audio/wav",
                ".ogg": "audio/ogg",
                ".pdf": "application/pdf",
              };
              res.setHeader(
                "Content-Type",
                mimeMap[ext] || "application/octet-stream",
              );
              res.setHeader("Cache-Control", "no-cache");
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Fall through if URI decoding or file access fails
          }
        }
        next();
      });
    },
  };
}
// LINT.ThenChange(//depot/google3/java/com/google/alkali/boq/makersuite/applet_dev_service/templates/initializers/react_theme/vite.config.ts:aistudio_media_plugin)

// Only public application shell files enter this cache. User media and API data
// remain in Drive / explicitly managed IndexedDB storage.
function pwaShellPlugin(): Plugin {
  return {
    name: "baudoku-pwa-shell",
    apply: "build",
    generateBundle(_options, bundle) {
      const shell = [
        "/index.html",
        "/manifest.webmanifest",
        "/icons/icon.svg",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/apple-touch-icon.png",
        ...Object.keys(bundle)
          .filter(
            (name) => name.startsWith("assets/") && !name.endsWith(".map"),
          )
          .map((name) => `/${name}`),
      ];
      const revision = createHash("sha256")
        .update(
          JSON.stringify(shell) +
            shell
              .filter(
                (file) =>
                  !file.startsWith("/assets/") && file !== "/index.html",
              )
              .map((file) =>
                fs.readFileSync(path.resolve("public", file.slice(1))),
              )
              .join("") +
            Object.values(bundle)
              .map((item) =>
                item.type === "chunk" ? item.code : String(item.source),
              )
              .join(""),
        )
        .digest("hex")
        .slice(0, 16);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `
const CACHE = 'baudoku-shell-${revision}';
const SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('baudoku-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/__/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match('/index.html'))));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(request)));
  }
});
`,
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), aistudioMediaPlugin(), pwaShellPlugin()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== "true",
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === "true" ? null : {},
    },
  };
});
