import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { onAuthStateChanged } from "firebase/auth";
import type { UsageEvent, UsagePageData, UsageTokens } from "../../shared/usage";
import { viennaDay, type UsageRange } from "./usage";
import { auth } from "./firebase";

export type ConsumptionScope = "mine" | "all";
type Identity = { uid: string; getIdToken(): Promise<string> };
export interface ConsumptionSnapshot extends UsagePageData { pagesLoaded: number }
export class ConsumptionLoadError extends Error {
  constructor(message: string, public code: "cancelled" | "forbidden" | "unauthorized" | "load", public snapshot: ConsumptionSnapshot | null = null) {
    super(message);
    this.name = "ConsumptionLoadError";
  }
}
export interface ConsumptionRequest {
  owner: string;
  range: UsageRange;
  scope: ConsumptionScope;
  currentUser?: () => Identity | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onPage?: (value: ConsumptionSnapshot) => void;
}

/** Known subtotal + coverage, so a missing measurement cannot become a zero. */
export interface ConsumptionMeasure { value: number | null; known: number; total: number }
export interface ConsumptionTotals {
  requests: number;
  tokens: Record<keyof UsageTokens, ConsumptionMeasure>;
  streaming: { connections: number; sessionSeconds: ConsumptionMeasure; audioSeconds: ConsumptionMeasure };
  batch: { jobs: number; audioSeconds: ConsumptionMeasure };
  cost: ConsumptionMeasure;
  states: Record<UsageEvent["state"], number>;
  evidence: Record<UsageEvent["evidence"], number>;
}
export interface ConsumptionGroup extends ConsumptionTotals {
  key: string;
  events: UsageEvent[];
  owner?: string;
  ownerLabel?: string;
  meetingId?: string;
  storage?: UsageEvent["storage"];
  provider?: UsageEvent["provider"];
  model?: string;
  operation?: UsageEvent["operation"];
}
export interface ConsumptionAggregate extends ConsumptionTotals {
  events: UsageEvent[];
  days: ConsumptionGroup[];
  models: ConsumptionGroup[];
  operations: ConsumptionGroup[];
  meetings: ConsumptionGroup[];
  accounts: ConsumptionGroup[];
  excludedInvalidDates: number;
}
const measure = (): ConsumptionMeasure => ({ value: null, known: 0, total: 0 });
const emptyTotals = (): ConsumptionTotals => ({
  requests: 0,
  tokens: { input: measure(), output: measure(), thinking: measure(), cached: measure(), total: measure() },
  streaming: { connections: 0, sessionSeconds: measure(), audioSeconds: measure() },
  batch: { jobs: 0, audioSeconds: measure() }, cost: measure(),
  states: { pending: 0, completed: 0, failed: 0, unknown: 0 }, evidence: { provider: 0, browser: 0, unknown: 0 },
});
function addMeasure(target: ConsumptionMeasure, value: unknown) {
  target.total++;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  target.known++;
  target.value = (target.value ?? 0) + value;
}
function addEvent(target: ConsumptionTotals, event: UsageEvent) {
  target.requests++;
  target.states[event.state]++;
  target.evidence[event.evidence]++;
  addMeasure(target.cost, event.cost?.currency === "USD" ? event.cost.usd : null);
  if (event.kind === "tokens") {
    for (const key of Object.keys(target.tokens) as (keyof UsageTokens)[]) addMeasure(target.tokens[key], event.tokens?.[key]);
  } else if (event.kind === "streaming") {
    target.streaming.connections++;
    addMeasure(target.streaming.sessionSeconds, event.sessionSeconds);
    addMeasure(target.streaming.audioSeconds, event.audioSeconds);
  } else if (event.kind === "batch") {
    target.batch.jobs++;
    addMeasure(target.batch.audioSeconds, event.audioSeconds);
  }
}

export function aggregateConsumption(events: readonly UsageEvent[], range: UsageRange): ConsumptionAggregate {
  const days = range.days.map((key) => ({ ...emptyTotals(), key, events: [] } as ConsumptionGroup));
  const result: ConsumptionAggregate = { ...emptyTotals(), events: [], days, models: [], operations: [], meetings: [], accounts: [], excludedInvalidDates: 0 };
  const unique = new Map<string, UsageEvent>();
  for (const event of events) {
    const key = JSON.stringify([event.owner, event.id]);
    const previous = unique.get(key);
    if (!previous || Date.parse(event.updatedAt) > Date.parse(previous.updatedAt)) unique.set(key, event);
  }
  const byDay = new Map(days.map((day) => [day.key, day]));
  const models = new Map<string, ConsumptionGroup>();
  const operations = new Map<string, ConsumptionGroup>();
  const meetings = new Map<string, ConsumptionGroup>();
  const accounts = new Map<string, ConsumptionGroup>();
  const group = (groups: Map<string, ConsumptionGroup>, key: string, metadata: Partial<ConsumptionGroup>) => {
    let entry = groups.get(key);
    if (!entry) { entry = { ...emptyTotals(), key, events: [], ...metadata }; groups.set(key, entry); }
    return entry;
  };
  // Newest metadata wins; labels remain accounting metadata, never report titles.
  for (const event of [...unique.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))) {
    const key = viennaDay(event.startedAt);
    if (!key) { result.excludedInvalidDates++; continue; }
    const day = byDay.get(key);
    if (!day) continue;
    result.events.push(event);
    const model = group(models, JSON.stringify([event.provider, event.model]), { provider: event.provider, model: event.model });
    const operation = group(operations, event.operation, { operation: event.operation });
    const meeting = group(meetings, JSON.stringify([event.owner, event.storage ?? null, event.meetingId ?? null]), {
      owner: event.owner, storage: event.storage, meetingId: event.meetingId,
    });
    const account = group(accounts, event.owner, { owner: event.owner, ownerLabel: event.ownerLabel });
    if (!account.ownerLabel && event.ownerLabel) account.ownerLabel = event.ownerLabel;
    addEvent(result, event);
    for (const target of [day, model, operation, meeting, account]) { addEvent(target, event); target.events.push(event); }
  }
  const sorted = (groups: Map<string, ConsumptionGroup>) => [...groups.values()].sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
  result.models = sorted(models);
  result.operations = sorted(operations);
  result.meetings = sorted(meetings);
  result.accounts = sorted(accounts);
  return result;
}

interface ConsumptionLoadState {
  identity: Identity | null;
  key: string;
  data: ConsumptionSnapshot | null;
  loading: boolean;
  error: string;
  forbidden: boolean;
  canViewAll: boolean;
}
export interface ConsumptionView {
  owner: string | null;
  scope: ConsumptionScope;
  events: UsageEvent[];
  loading: boolean;
  loaded: boolean;
  partial: boolean;
  error: string;
  forbidden: boolean;
  canViewAll: boolean;
  pagesLoaded: number;
  trackingSince: string | null;
  historyComplete: false;
  reload: () => void;
}
const subscribeIdentity = (listener: () => void) => onAuthStateChanged(auth, () => listener());
const identitySnapshot = () => auth.currentUser;

export function useConsumption(range: UsageRange, scope: ConsumptionScope = "mine"): ConsumptionView {
  const identity = useSyncExternalStore(subscribeIdentity, identitySnapshot, identitySnapshot);
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((value) => value + 1), []);
  const key = JSON.stringify([range.start, range.end, scope, epoch]);
  const [state, setState] = useState<ConsumptionLoadState>({
    identity: null, key: "", data: null, loading: false, error: "", forbidden: false, canViewAll: false,
  });
  useEffect(() => {
    const controller = new AbortController();
    if (!identity) return () => controller.abort();
    const current = () => !controller.signal.aborted && auth.currentUser === identity;
    setState((previous) => ({
      identity, key, data: null, loading: true, error: "", forbidden: false,
      canViewAll: previous.identity === identity && previous.canViewAll,
    }));
    const accept = (data: ConsumptionSnapshot, loading: boolean) => {
      if (current()) setState({ identity, key, data, loading, error: "", forbidden: false, canViewAll: data.canViewAll });
    };
    void loadConsumption({ owner: identity.uid, range, scope, signal: controller.signal, onPage: (data) => accept(data, true) })
      .then((data) => accept(data, false))
      .catch((cause) => {
        if (!current() || cause instanceof ConsumptionLoadError && cause.code === "cancelled") return;
        const failure = cause instanceof ConsumptionLoadError ? cause : new ConsumptionLoadError("Verbrauch konnte nicht geladen werden.", "load");
        setState((previous) => ({
          identity, key, data: failure.snapshot, loading: false, error: failure.message, forbidden: failure.code === "forbidden",
          canViewAll: failure.code === "load" && previous.identity === identity && previous.canViewAll,
        }));
      });
    return () => controller.abort();
  }, [identity, range.start, range.end, scope, epoch]);
  // Fence in render, not only in an effect: the old account/query can never flash.
  const visible = !!identity && state.identity === identity && state.key === key;
  const data = visible ? state.data : null;
  const loading = !!identity && (!visible || state.loading);
  const error = visible ? state.error : "";
  return {
    owner: identity?.uid ?? null, scope, events: data?.events ?? [], loading, loaded: !!data,
    partial: !!data && (loading || !!error || data.nextCursor !== null), error,
    forbidden: visible && state.forbidden,
    canViewAll: !!identity && state.identity === identity && state.canViewAll,
    pagesLoaded: data?.pagesLoaded ?? 0, trackingSince: data?.trackingSince ?? null, historyComplete: false, reload,
  };
}

/** Validate renderable metadata; absent/null provider counts remain unknown. */
function validEvent(event: UsageEvent): boolean {
  const text = (value: unknown) => value == null || typeof value === "string";
  return !!event && typeof event.id === "string" && !!event.id && typeof event.owner === "string" && !!event.owner &&
    typeof event.startedAt === "string" && typeof event.updatedAt === "string" && typeof event.model === "string" &&
    ["summary", "ask", "insights", "consent", "legacy-transcribe", "legacy-stitch", "live-transcription", "batch-transcription"].includes(event.operation) &&
    ["gemini", "assemblyai"].includes(event.provider) && ["tokens", "streaming", "batch"].includes(event.kind) &&
    ["pending", "completed", "failed", "unknown"].includes(event.state) && ["provider", "browser", "unknown"].includes(event.evidence) &&
    [event.ownerLabel, event.meetingId, event.providerRequestId, event.modelVersion].every(text) &&
    (event.storage == null || ["google", "microsoft"].includes(event.storage)) &&
    (event.source == null || ["mic", "system"].includes(event.source)) &&
    (event.session == null || Number.isInteger(event.session) && event.session >= 0) &&
    (event.features == null || Array.isArray(event.features) && event.features.every((feature) => typeof feature === "string")) &&
    (event.tokens == null || typeof event.tokens === "object" && !Array.isArray(event.tokens)) &&
    !!event.cost && event.cost.currency === "USD" && [event.cost.rateId, event.cost.rateSource, event.cost.rateCheckedAt, event.cost.reason].every(text);
}

/** Account identity is pinned before token lookup, not chosen after it resolves. */
export async function loadConsumption(options: ConsumptionRequest): Promise<ConsumptionSnapshot> {
  const currentUser = options.currentUser ?? (() => auth.currentUser);
  const user = currentUser();
  const owned = () => {
    if (options.signal?.aborted || !user || user.uid !== options.owner || currentUser() !== user) {
      throw new ConsumptionLoadError("Konto gewechselt oder Laden abgebrochen.", "cancelled");
    }
  };
  owned();
  const unique = new Map<string, UsageEvent>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pagesLoaded = 0;
  let result: ConsumptionSnapshot | null = null;
  try {
    do {
      owned();
      const token = await user.getIdToken();
      owned();
      if (!token) throw new ConsumptionLoadError("Bitte erneut anmelden.", "unauthorized");
      const query = new URLSearchParams({ start: options.range.start, end: options.range.end, scope: options.scope });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await (options.fetchImpl ?? fetch)(`/api/usage?${query}`, {
        method: "GET", headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: options.signal,
      });
      owned();
      if (response.status === 403) throw new ConsumptionLoadError("Keine Berechtigung für diese Ansicht.", "forbidden");
      if (response.status === 401) throw new ConsumptionLoadError("Bitte erneut anmelden.", "unauthorized");
      if (!response.ok) throw new Error("Verbrauch konnte nicht geladen werden.");
      const page = await response.json() as UsagePageData;
      owned();
      if (!page || page.scope !== options.scope || typeof page.canViewAll !== "boolean" || page.historyComplete !== false ||
        !(page.trackingSince === null || typeof page.trackingSince === "string") || !Array.isArray(page.events) ||
        !(page.nextCursor === null || typeof page.nextCursor === "string" && page.nextCursor.length > 0) ||
        page.events.some((event) => !validEvent(event) || options.scope === "mine" && event.owner !== options.owner)) {
        throw new Error("Ungültige Verbrauchsantwort.");
      }
      if (options.scope === "all" && !page.canViewAll) throw new ConsumptionLoadError("Keine Berechtigung für die Betreiberansicht.", "forbidden");
      if (page.nextCursor !== null && cursors.has(page.nextCursor)) throw new Error("Wiederholte Seite.");
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
      for (const event of page.events) {
        const key = JSON.stringify([event.owner, event.id]);
        const previous = unique.get(key);
        if (!previous || Date.parse(event.updatedAt) > Date.parse(previous.updatedAt)) unique.set(key, event);
      }
      const trackingSince = [result?.trackingSince, page.trackingSince].filter((value): value is string => !!value).sort()[0] ?? null;
      result = { ...page, trackingSince, events: [...unique.values()], pagesLoaded: ++pagesLoaded };
      owned();
      options.onPage?.(result);
      owned();
      cursor = page.nextCursor;
    } while (cursor !== null);
    return result;
  } catch (cause) {
    // Even a rejected await may coincide with an account transition.
    owned();
    if (cause instanceof ConsumptionLoadError) throw cause;
    throw new ConsumptionLoadError("Verbrauch konnte nicht vollständig geladen werden. Bitte erneut versuchen.", "load", result);
  }
}
