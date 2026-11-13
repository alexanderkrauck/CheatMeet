import React from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
vi.mock("../lib/capture", () => ({ captureSnapshot: () => ({ state: "ready" }), subscribeCapture: () => () => {} }));
vi.mock("../lib/firebase", () => ({ auth: { currentUser: { uid: "owner" } } }));
vi.mock("../lib/pipeline", () => ({ jobFor: () => ({ stage: "error", error: "Drive-Revisionsprüfung fehlgeschlagen" }) }));
vi.mock("../lib/local", () => ({ getLocal: vi.fn() }));
vi.mock("../lib/reports", () => ({ saveReport: vi.fn() }));
vi.mock("../lib/session", () => ({ errorMessage: String }));
import AttentionQueue from "./AttentionQueue";

it("shows a blocked server backup even when its report index still says pending", () => {
  const workspace = { reports: [{ id: "backup", title: "Backup", status: "pending" }], dirty: [], drafts: [], error: "", draftsError: "", running: new Set(), reload: vi.fn() } as any;
  const html = renderToStaticMarkup(<MemoryRouter><AttentionQueue workspace={workspace} /></MemoryRouter>);
  expect(html).toContain("Drive-Revisionsprüfung fehlgeschlagen");
});
