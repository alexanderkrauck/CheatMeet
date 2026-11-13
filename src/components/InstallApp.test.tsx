import React from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
vi.mock("../lib/install", () => ({
  installState: () => ({ prompt: {}, update: null, ios: false }),
  subscribeInstall: () => () => {},
  applyUpdate: vi.fn(),
  runInstall: vi.fn(),
}));
import InstallApp from "./InstallApp";
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
