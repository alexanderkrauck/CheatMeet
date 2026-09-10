import { readFile, access } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const source = await readFile(
  new URL("../dist/sw.js", import.meta.url),
  "utf8",
);
function worker() {
  const listeners = {};
  const stores = new Map();
  const deleted = [];
  const requests = [];
  let offline = false;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name) => {
      deleted.push(name);
      return stores.delete(name);
    },
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        addAll: async (urls) => {
          for (const url of urls)
            entries.set(url, new Response(`cached:${url}`));
        },
        match: async (url) => entries.get(url)?.clone(),
      };
    },
  };
  const self = {
    location: { origin: "https://baudoku.test" },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
  };
  vm.runInNewContext(source, {
    self,
    caches,
    URL,
    fetch: async (request) => {
      requests.push(request);
      if (offline) throw new Error("offline");
      return new Response("network");
    },
  });
  async function lifecycle(name) {
    let work;
    listeners[name]({
      waitUntil: (promise) => {
        work = promise;
      },
    });
    await work;
  }
  async function request(url, mode = "cors", method = "GET") {
    let result;
    listeners.fetch({
      request: { url, mode, method },
      respondWith: (promise) => {
        result = promise;
      },
    });
    return result;
  }
  return {
    stores,
    deleted,
    requests,
    lifecycle,
    request,
    setOffline: () => {
      offline = true;
    },
  };
}

test("emitted shell files exist and manifest supplies installable icons", async () => {
  const w = worker();
  await w.lifecycle("install");
  const paths = [...w.stores.values()][0].keys();
  for (const path of paths)
    await access(new URL(`../dist${path}`, import.meta.url));
  const manifest = JSON.parse(
    await readFile(
      new URL("../dist/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
});

test("offline deep-link navigation returns public shell without caching online pages", async () => {
  const w = worker();
  await w.lifecycle("install");
  assert.equal(
    await (
      await w.request("https://baudoku.test/report/private-id", "navigate")
    ).text(),
    "network",
  );
  w.setOffline();
  assert.equal(
    await (
      await w.request("https://baudoku.test/report/private-id", "navigate")
    ).text(),
    "cached:/index.html",
  );
  assert.equal([...w.stores.values()][0].has("/report/private-id"), false);
});

test("authenticated APIs, Firebase auth helpers, Drive and mutations bypass the service worker", async () => {
  const w = worker();
  await w.lifecycle("install");
  w.setOffline();
  for (const [url, mode, method] of [
    ["https://baudoku.test/api/analyze", "cors", "POST"],
    ["https://baudoku.test/api/health", "navigate", "GET"],
    ["https://baudoku.test/__/auth/handler", "navigate", "GET"],
    [
      "https://www.googleapis.com/drive/v3/files/private?alt=media",
      "cors",
      "GET",
    ],
    ["https://baudoku.test/manifest.webmanifest", "cors", "POST"],
  ])
    assert.equal(await w.request(url, mode, method), undefined);
  assert.equal(w.requests.length, 0);
});

test("activation deletes only obsolete Baudoku shell caches", async () => {
  const w = worker();
  await w.lifecycle("install");
  w.stores.set("baudoku-shell-obsolete", new Map());
  w.stores.set("other-app-cache", new Map());
  await w.lifecycle("activate");
  assert.deepEqual(w.deleted, ["baudoku-shell-obsolete"]);
  assert.ok(w.stores.has("other-app-cache"));
});

test("production Express serves the generated manifest, worker and deep-link shell", async (t) => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["dist/server.cjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: "pipe",
  });
  t.after(() => {
    child.kill();
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Production server exited ${child.exitCode}`);
    try {
      ready = (await fetch(`${base}/api/health`)).ok;
    } catch {
      /* startup pending */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "server starts in production mode");
  const worker = await fetch(`${base}/sw.js`);
  assert.match(worker.headers.get("content-type"), /javascript/);
  assert.match(worker.headers.get("cache-control"), /no-cache/);
  assert.equal(await worker.text(), source);
  assert.equal(
    (await (await fetch(`${base}/manifest.webmanifest`)).json()).short_name,
    "Baudoku",
  );
  const deepLink = await fetch(`${base}/report/example`);
  const html = await deepLink.text();
  assert.match(html, /\/assets\/index-/);
  assert.doesNotMatch(html, /\/src\/main.tsx|@vite\/client/);
  const missingApi = await fetch(`${base}/api/does-not-exist`);
  assert.equal(missingApi.status, 404);
  assert.match(missingApi.headers.get("content-type"), /application\/json/);
});
