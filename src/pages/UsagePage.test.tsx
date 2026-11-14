import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageEvent } from "../../shared/usage";

const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, user: { uid: "alice" } as { uid: string } | null, view: {} as any, requests: [] as any[], reports: vi.fn(), reportRows: [] as any[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: any) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [h.slots[index], (next: any) => { h.slots[index] = typeof next === "function" ? next(h.slots[index]) : next; }];
  },
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock("../lib/firebase", () => ({ auth: { get currentUser() { return h.user; } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: vi.fn(() => () => {}) }));
vi.mock("react-router-dom", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
vi.mock("../lib/session", () => ({ errorMessage: String }));
vi.mock("../lib/consumption", async (original) => ({
  ...(await original<typeof import("../lib/consumption")>()),
  useConsumption: (range: unknown, ...extra: unknown[]) => { h.requests.push({ range, ...(extra.length ? { scope: extra[0] } : {}) }); return h.view; },
}));
vi.mock("../components/UI", () => ({
  Busy: ({ text }: { text: string }) => <div role="status">{text}</div>,
  Notice: ({ children, kind }: { children: React.ReactNode; kind?: string }) => <div role={kind === "info" ? "status" : "alert"}>{children}</div>,
}));
vi.mock("../lib/useReports", () => ({ useReports: () => { h.reports(); return ({
  reports: h.reportRows,
  loading: false, error: "", dirty: [], reload: vi.fn(),
}); } }));
import UsagePage from "./UsagePage";

const event = (id: string, patch: Partial<UsageEvent> = {}): UsageEvent => ({
  id, owner: "alice", meetingId: "fixture-meeting", storage: "google", operation: "summary", provider: "gemini", kind: "tokens", model: "gemini-fixture",
  startedAt: "2026-11-14T09:00:00Z", updatedAt: "2026-11-14T09:01:00Z", state: "completed", evidence: "provider",
  tokens: { input: 12345, output: 321, thinking: 87, cached: 1024, total: 12753 },
  cost: { usd: 0.0042, currency: "USD", rateId: "fixture-rate", rateSource: "https://example.invalid/pricing", rateCheckedAt: "2026-11-14" }, ...patch,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
  h.slots = []; h.cursor = 0; h.requests = []; h.user = { uid: "alice" }; h.reports.mockClear();
  h.reportRows = [{ id: "qa-meeting", date: "2026-11-14T09:00:00Z", durationMs: 60_000, summary: "QA" }];
  h.view = { owner: "alice", events: [event("one")], loaded: true, loading: false, partial: false, error: "", pagesLoaded: 1, trackingSince: "2026-11-14T00:00:00Z", historyComplete: false, reload: vi.fn() };
});
afterEach(() => vi.useRealTimers());
const render = () => { h.cursor = 0; return renderToStaticMarkup(<UsagePage />); };
type Element = React.ReactElement<any>;
function nodes(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement(node)) return [];
  return [node, ...nodes((node as Element).props.children)];
}
function text(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return React.isValidElement(node) ? text((node as Element).props.children) : "";
}
const tree = () => { h.cursor = 0; return UsagePage(); };
const press = (label: string) => {
  const button = nodes(tree()).find((node) => node.type === "button" && (text(node) === label || node.props["aria-label"] === label));
  expect(button, label).toBeDefined();
  button!.props.onClick();
};

it("uses known own titles and provider-qualified report links, with full stable IDs for unknown meetings", () => {
  h.reportRows = [
    { ...h.reportRows[0], id: "same-meeting", title: "Eigener Google-Termin" },
    { ...h.reportRows[0], id: "same-meeting", title: "Eigener Microsoft-Termin", home: { provider: "microsoft", driveId: "fixture-drive", itemId: "fixture-item" } },
  ];
  const deletedId = "deleted-meeting-full-stable-id-123456";
  h.view.events = [
    event("google", { meetingId: "same-meeting", storage: "google" }),
    event("microsoft", { meetingId: "same-meeting", storage: "microsoft" }),
    event("deleted", { meetingId: deletedId }),
    event("unqualified", { meetingId: "same-meeting", storage: undefined }),
  ];
  const html = render();
  expect(html).toContain('href="/report/same-meeting?index=reports"');
  expect(html).toContain('href="/report/same-meeting?index=meetings"');
  expect(html).toContain("Eigener Google-Termin");
  expect(html).toContain("Eigener Microsoft-Termin");
  expect(html).toContain(`Meeting ${deletedId}`);
  expect(html).toContain("Meeting same-meeting");
  for (const summary of html.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/g) || []) {
    expect(summary).not.toMatch(/<(a|button|input|select)\b/);
  }
  expect(h.reports).toHaveBeenCalledOnce();
});

it("never offers cross-account controls even if legacy privilege flags are injected", () => {
  h.view.canViewAll = true;
  h.view.scope = "all";
  h.view.events = [event("mine"), { ...event("FOREIGN-RECEIPT", { owner: "bob", ownerLabel: "Bob Example", model: "FOREIGN-MODEL" }), title: "PRIVATE-REPORT-TITLE", transcription: "PRIVATE-TRANSCRIPT" }];
  h.reportRows = [{ ...h.reportRows[0], id: "fixture-meeting", title: "OWN-MEETING-TITLE" }];
  const html = render();
  expect(html).not.toContain("Alle Konten");
  expect(html).not.toContain("Verbrauchsumfang");
  expect(html).not.toContain("Kontenübersicht");
  expect(html).not.toContain("Betreiberansicht");
  expect(h.requests.at(-1)).not.toHaveProperty("scope");
  expect(html).not.toContain("Bob Example");
  expect(html).not.toContain("FOREIGN-MODEL");
  expect(html).not.toContain("FOREIGN-RECEIPT");
  expect(html).not.toContain("PRIVATE-REPORT-TITLE");
  expect(html).not.toContain("PRIVATE-TRANSCRIPT");
  expect(html).toContain("OWN-MEETING-TITLE");
  expect(html).toContain("1 erfasster Vorgang");
  expect(html).toContain("Meeting-Aktivität");
  expect(h.reports).toHaveBeenCalledOnce();
});

it("preserves a denied own-read error and retry without an alternative account mode", () => {
  h.view.events = [event("foreign", { owner: "bob", ownerLabel: "Bob Example" })];
  h.view.loaded = false; h.view.error = "Keine Berechtigung für diese Ansicht.";
  const html = render();
  expect(html).not.toContain("Bob Example");
  expect(html).not.toContain("Alle Konten");
  expect(html).not.toContain("Kontenübersicht");
  expect(html).toContain("Keine Berechtigung");
  press("Erneut versuchen");
  expect(h.view.reload).toHaveBeenCalledOnce();
  expect(h.requests.at(-1)).not.toHaveProperty("scope");
});

it("never flashes stale foreign rows when the account changes", () => {
  h.view.events = [event("private-old", { model: "PRIVATE-OLD-MODEL" })];
  h.user = { uid: "carla" };
  const html = render();
  expect(h.requests.at(-1)).not.toHaveProperty("scope");
  expect(html).not.toContain("PRIVATE-OLD-MODEL");
  expect(html).not.toContain("Alle Konten");
  expect(html).not.toContain("Kontenübersicht");
});

it("keeps empty historical consumption unknown rather than displaying a zero-dollar bill", () => {
  h.view.events = [];
  h.view.trackingSince = null;
  const html = render();
  expect(html).toContain("Keine erfassten Vorgänge im Zeitraum");
  expect(html).toContain("Ältester Vorgang noch unbekannt");
  expect(html).toContain("Unbekannt");
  expect(html).not.toContain("0,0000 USD");
  expect(html).not.toContain("consumption-models");
});

it("shows recovered historical costs without claiming continuous tracking began at the oldest row", () => {
  h.slots = ["month", "2026-09-14"];
  h.view.trackingSince = "2026-09-14T14:36:03.653Z";
  h.view.events = [event("recovered-batch", {
    provider: "assemblyai", kind: "batch", operation: "batch-transcription", model: "universal-3-5-pro",
    startedAt: "2026-09-14T14:36:03.653Z", tokens: undefined, audioSeconds: 60,
    cost: { usd: 60 / 3600 * 0.23, currency: "USD", rateId: "fixture-historical-current-rate-reconstruction",
      rateSource: "https://example.invalid/pricing", rateCheckedAt: "2026-11-14",
      reason: "Nachträglich rekonstruiert; zum geprüften Tarif geschätzt, kein damaliger Rechnungsbetrag." },
  })];
  const html = render();
  expect(html).toContain("Historie unvollständig");
  expect(html).toContain("Ältester vorhandener Vorgang");
  expect(html).not.toContain("Erfassung laut Protokoll ab");
  expect(html).toContain("Rekonstruierte Kosten sind Schätzungen");
  expect(html).toContain("Nachträglich rekonstruiert");
  expect(html).toContain("kein damaliger Rechnungsbetrag");
  expect(html).not.toContain("Tarif-Snapshots zum Vorgangsbeginn");
  expect(html).toContain("am Vorgang gespeicherten Tarif-Snapshot");
  expect(html).toContain("60 s");
  expect(html).toContain("USD");
});

it("marks partial pagination and failed loading explicitly, without turning unknown receipts into zero", () => {
  h.view.events = [event("unknown", { state: "unknown", evidence: "unknown", tokens: undefined, cost: { usd: null, currency: "USD" } })];
  h.view.partial = true; h.view.error = "Verbrauch konnte nicht vollständig geladen werden."; h.view.pagesLoaded = 2;
  const html = render();
  expect(html).toContain("Vorläufige Teilsumme");
  expect(html).toContain("2 Seiten geladen");
  expect(html).toContain("1 Ohne Nutzungsbestätigung");
  expect(html).toContain("1 Status unbekannt");
  expect(html).not.toContain("0,0000 USD");
  press("Erneut versuchen");
  expect(h.view.reload).toHaveBeenCalledOnce();
});

it("shows a loading state, not an empty bill, while the first page is pending", () => {
  h.view.events = []; h.view.loaded = false; h.view.loading = true;
  const html = render();
  expect(html).toContain("Verbrauchsprotokoll laden");
  expect(html).not.toContain("Keine erfassten Vorgänge im Zeitraum");
  expect(html).not.toContain("Gemessener Verbrauch im gewählten Zeitraum");
  expect(html).toContain('aria-busy="true"');
});

it("calls out invalid operation dates even when no valid row can be placed in the selected period", () => {
  h.view.events = [event("invalid-date", { startedAt: "invalid", cost: { usd: null, currency: "USD" } })];
  const html = render();
  expect(html).toContain("1 Vorgang ohne gültigen Beginn");
  expect(html).not.toContain("0,0000 USD");
});

it("sends Vienna day/week/month operation-start ranges with an exclusive end and keeps navigation functional", () => {
  press("Tag"); render();
  expect(h.requests.at(-1)).toEqual({ range: expect.objectContaining({ start: "2026-11-14", end: "2026-11-15" }) });
  press("Vorheriger Tag"); render();
  expect(h.requests.at(-1)).toMatchObject({ range: { start: "2026-11-13", end: "2026-11-14" } });
  press("Heute"); press("Woche"); render();
  expect(h.requests.at(-1)).toMatchObject({ range: { start: "2026-11-09", end: "2026-11-16" } });
  press("Monat"); press("Nächster Monat"); render();
  expect(h.requests.at(-1)).toMatchObject({ range: { start: "2026-12-01", end: "2027-01-01" } });
  press("Dieser Monat"); render();
  expect(h.requests.at(-1)).toMatchObject({ range: { start: "2026-11-01", end: "2026-12-01" } });
});

it("does not round a measured sub-microdollar estimate into a free request or link an unsafe rate source", () => {
  h.view.events = [event("tiny", { cost: { usd: 0.0000001, currency: "USD", rateSource: "javascript:alert(1)" } })];
  const html = render();
  expect(html).toContain("&lt; 0,000001 USD");
  expect(html).not.toContain("0,0000 USD");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("Tarifquelle nicht verfügbar");
});

it("explains separate source connections, unpriced/pending usage and request-level rate evidence in model/operation/meeting rollups", () => {
  h.view.events = [
    event("gemini-attempt", { providerRequestId: "provider-request-123", modelVersion: "gemini-version-42" }),
    event("mic-1", { operation: "live-transcription", provider: "assemblyai", model: "streaming-model", kind: "streaming", source: "mic", session: 1, tokens: undefined, sessionSeconds: 65, audioSeconds: 60, evidence: "browser", cost: { usd: null, currency: "USD", reason: "Tarif nicht bekannt" } }),
    event("system-1", { operation: "live-transcription", provider: "assemblyai", model: "streaming-model", kind: "streaming", source: "system", session: 1, tokens: undefined, sessionSeconds: 63, audioSeconds: 58, evidence: "browser", cost: { usd: null, currency: "USD" } }),
    event("mic-2", { operation: "live-transcription", provider: "assemblyai", model: "streaming-model", kind: "streaming", source: "mic", session: 2, tokens: undefined, state: "pending", evidence: "unknown", cost: { usd: null, currency: "USD" } }),
    event("batch", { operation: "batch-transcription", provider: "assemblyai", model: "batch-model", kind: "batch", storage: "microsoft", tokens: undefined, audioSeconds: 60, features: ["speaker_diarization"], cost: { usd: 0.001, currency: "USD" } }),
  ];
  const html = render();
  for (const value of ["Modelle &amp; Verbrauch", "Vorgänge", "Nach Meeting", "Zusammenfassung", "Live-Transkription", "Batch-Transkription", "streaming-model", "batch-model", "Google Drive", "Microsoft OneDrive", "Mikrofon · Verbindung 1", "Systemaudio · Verbindung 1", "Mikrofon · Verbindung 2", "provider-request-123", "gemini-version-42", "fixture-rate", "Tarif nicht bekannt", "Browser-relay", "Ausstehend", "speaker_diarization"]) {
    expect(html).toContain(value);
  }
  expect(html).toContain('href="https://example.invalid/pricing"');
  expect(html).toContain("128 s");
  expect(html).toContain("2 von 3 bekannt");
  expect(html).toContain("nicht serverseitig als Abrechnung verifiziert");
  expect(html).toContain("Rabatte, Gutschriften, Steuern, Hosting und Speicher");
  expect(html).toContain("Verbrauch nach Vorgangsbeginn");
  expect(html.match(/<details class="usage-request"/g)).toHaveLength(5);
});

it("presents measured token categories and USD estimates as primary usage, with separate legacy activity", () => {
  const html = render();
  expect(html).toContain("Gemini-Tokens");
  expect(html).toContain("Thinking");
  expect(html).toContain("Cache");
  expect(html).toContain("321");
  expect(html).toContain("0,0042");
  expect(html).toContain("USD");
  expect(html).toContain("Historie unvollständig");
  expect(html).toContain("Meeting-Aktivität");
  expect(html.indexOf("Gemini-Tokens")).toBeLessThan(html.indexOf("Meeting-Aktivität"));
  expect(h.requests[0]).toEqual({ range: { start: "2026-11-01", end: "2026-12-01", days: expect.any(Array) } });
});

it("puts days with activity first instead of burying them behind a month of zero rows", () => {
  const html = render();
  const rows = html.match(/<caption>Meetings nach Meeting-Datum[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr\b/g);
  expect(rows).toHaveLength(1);
  expect(html).toContain("Tage ohne Meetings anzeigen");
});
