import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("firebase/auth", () => ({ signOut: vi.fn() }));
vi.mock("../lib/firebase", () => ({ auth: { currentUser: { uid: "qa-owner", displayName: "QA" } } }));
vi.mock("./PeopleDatalist", () => ({ default: () => null }));
vi.mock("./InstallApp", () => ({ default: () => null }));
import AppLayout from "./AppLayout";

afterEach(() => vi.unstubAllGlobals());

it("makes usage reachable and marks the active destination in both navigation surfaces", () => {
  vi.stubGlobal("navigator", { onLine: true });
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/usage"]}><AppLayout /></MemoryRouter>);
  const links = [...html.matchAll(/<a\b[^>]*href="\/usage"[^>]*>[\s\S]*?<\/a>/g)].map(([link]) => link);
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link).toContain("Nutzung");
    expect(link).toContain('aria-current="page"');
  }
});

it("advertises modified shortcuts instead of capturing ordinary letter keys", () => {
  vi.stubGlobal("navigator", { onLine: true });
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/dashboard"]}><AppLayout /></MemoryRouter>);
  const shortcuts = [...html.matchAll(/aria-keyshortcuts="([^"]+)"/g)].map(([, shortcut]) => shortcut);
  expect(shortcuts).toContain("Control+k Meta+k");
  expect(shortcuts).toContain("Alt+n");
  expect(shortcuts).not.toContain("n");
  expect(shortcuts).not.toContain("/");
});
