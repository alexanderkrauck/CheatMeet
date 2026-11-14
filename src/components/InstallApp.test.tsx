import React from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
vi.mock("../lib/install", () => ({
  installState: () => ({ prompt: {}, update: null, ios: false }),
  subscribeInstall: () => () => {},
  applyUpdate: vi.fn(),
  canApplyUpdate: () => true,
  runInstall: vi.fn(),
}));
vi.mock("../lib/capture", () => ({ captureSnapshot: () => null, subscribeCapture: () => () => {} }));
vi.mock("../lib/pipeline", () => ({ activeJobs: () => [], subscribeJobs: () => () => {} }));
import InstallApp from "./InstallApp";
it("never interrupts setup, recording or assistant consent after sign-in", () => {
  for (const path of ["/setup", "/record?new=1", "/connect?request=demo"]) {
    expect(renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><InstallApp signedIn /></MemoryRouter>)).toBe("");
  }
});
it("keeps installation UI off signed-out login and assistant consent without hiding it after sign-in", () => {
  for (const path of ["/", "/connect?request=demo"]) {
    expect(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
          <InstallApp signedIn={false} />
        </MemoryRouter>,
      ),
    ).toBe("");
  }
  expect(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <InstallApp signedIn={true} />
      </MemoryRouter>,
    ),
  ).toContain("App installieren oder aktualisieren");
});
