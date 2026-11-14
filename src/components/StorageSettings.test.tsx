import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ allowed: true, state: "ready", jobs: [] as any[] }));
vi.mock("../lib/install", () => ({
  installState: () => ({ update: {}, prompt: null, ios: false }),
  subscribeInstall: () => () => {},
  canApplyUpdate: () => m.allowed,
  applyUpdate: vi.fn(),
  runInstall: vi.fn(),
}));
vi.mock("../lib/capture", () => ({
  captureSnapshot: () => ({ state: m.state }),
  subscribeCapture: () => () => {},
}));
vi.mock("../lib/pipeline", () => ({
  activeJobs: () => m.jobs,
  subscribeJobs: () => () => {},
}));
vi.mock("../lib/local", () => ({ inspectStorage: async () => ({}), releaseSyncedAudio: vi.fn() }));
vi.mock("../lib/reports", () => ({ uid: () => "u" }));
vi.mock("../lib/session", () => ({ errorMessage: String }));
import StorageSettings from "./StorageSettings";

beforeEach(() => { m.allowed = true; m.state = "ready"; m.jobs = []; });
const render = () => renderToStaticMarkup(<StorageSettings />);
const updateButton = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes("Neue Version laden")) || "";
it.each(["armed", "recording", "paused", "browser-upload"])("disables a waiting update with an explanation during %s", state => {
  m.allowed = false;
  m.state = state;
  if (state === "browser-upload") m.jobs = [{ stage: "uploading", serverOwned: false }];
  const html = render();
  expect(updateButton(html).split(">")[0]).toContain("disabled");
  expect(html).toContain("Nach der laufenden Aufnahme oder dem Upload aktualisieren.");
  expect(html).toContain('aria-describedby="storage-update-wait"');
});
it.each(["ready", "server-processing"])("allows a waiting update during %s", state => {
  m.state = state;
  if (state === "server-processing") m.jobs = [{ stage: "analyzing", serverOwned: true }];
  const html = render();
  const button = updateButton(html);
  expect(button).toContain("Neue Version laden");
  expect(button.split(">")[0]).not.toContain("disabled");
  expect(html).not.toContain("storage-update-wait");
});
