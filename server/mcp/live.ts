import express, { type Request, type Response, type Router } from "express";
import { LIVE_MAX_PUSH_BYTES, applyPush, type LiveDoc, type LivePush } from "../../shared/mcp";
import type { DocStore } from "./docStore";
import type { Grant } from "./oauth";

export interface LiveDeps {
  grants: DocStore<Grant>;
  live: DocStore<LiveDoc>;
  now?: () => number;
  /** Firebase ID token -> uid. */
  verifyToken: (token: string) => Promise<string>;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_MEETINGS = 5;
const MIN_PUSH_GAP_MS = 700;
const GRANT_CACHE_MS = 10_000;
const RUNNING_TTL = 6 * 3_600_000;
const ENDED_TTL = 30 * 60_000;
const MAX_TURNS = 20_000;
const MAX_TEXT = 20_000;

const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error, ...extra });

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e10;

/** Accepts only well-formed turns, copying known fields so nothing else is stored. */
function cleanTurn(value: any) {
  if (!value || typeof value !== "object") return null;
  if (!isString(value.id, 200) || !value.id || !isString(value.speaker, 200) || !isString(value.text, MAX_TEXT)) return null;
  if (!isTime(value.startMs) || !isTime(value.endMs) || typeof value.final !== "boolean") return null;
  return {
    id: value.id, startMs: value.startMs, endMs: value.endMs, speaker: value.speaker, text: value.text, final: value.final,
    ...(value.source === "mic" || value.source === "system" ? { source: value.source } : {}),
  };
}
function cleanPush(body: any): LivePush | null {
  if (!body || typeof body !== "object") return null;
  if (!Number.isSafeInteger(body.seq) || body.seq < 1) return null;
  if (!["recording", "paused", "ended"].includes(body.state)) return null;
  if (!isString(body.startedAt, 40) || !Number.isFinite(Date.parse(body.startedAt))) return null;
  if (!Array.isArray(body.languages) || body.languages.length > 8 || !body.languages.every((l: unknown) => isString(l, 12))) return null;
  if (!Array.isArray(body.upsert) || body.upsert.length > MAX_TURNS || !Array.isArray(body.remove) || body.remove.length > MAX_TURNS) return null;
  const upsert = body.upsert.map(cleanTurn);
  if (upsert.some((t: unknown) => !t)) return null;
  if (!body.remove.every((id: unknown) => isString(id, 200))) return null;
  const names: Record<string, string> = {};
  if (body.speakerNames && typeof body.speakerNames === "object") {
    const entries = Object.entries(body.speakerNames as Record<string, unknown>);
    if (entries.length > 200) return null;
    for (const [key, name] of entries) if (isString(key, 200) && isString(name, 200)) names[key] = name;
  }
  return {
    seq: body.seq, reset: body.reset === true ? true : undefined, startedAt: body.startedAt, languages: body.languages,
    state: body.state, upsert, remove: body.remove, speakerNames: names,
  };
}

/**
 * The recording tab pushes its transcript here while an assistant may be
 * reading along. Text is stored only while the account holds an active grant
 * with the live scope; without one the answer is `listening: false` and
 * nothing is written, so an unused feature keeps no transcripts on the server.
 */
export function createLiveRouter(deps: LiveDeps): Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const lastPush = new Map<string, number>();
  const listeners = new Map<string, { at: number; listening: boolean }>();

  const listening = async (uid: string) => {
    const cached = listeners.get(uid);
    if (cached && now() - cached.at < GRANT_CACHE_MS) return cached.listening;
    const grants = await deps.grants.listByOwner(uid);
    const value = grants.some((g) => g.status === "active" && g.scopes.includes("meetings:live"));
    listeners.set(uid, { at: now(), listening: value });
    if (listeners.size > 5000) for (const [key, entry] of listeners) if (now() - entry.at > GRANT_CACHE_MS) listeners.delete(key);
    return value;
  };
  const identify = async (req: Request) => {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
    if (!match) return null;
    return deps.verifyToken(match[1]).catch(() => null);
  };
  const key = (uid: string, reportId: string) => `${uid}:${reportId}`;
  const meta = (doc: LiveDoc, uid: string) => ({
    ownerKey: uid,
    expireAt: new Date(now() + (doc.state === "ended" ? ENDED_TTL : RUNNING_TTL)),
  });

  router.put(
    "/live/:reportId",
    express.json({ limit: LIVE_MAX_PUSH_BYTES }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const uid = await identify(req);
      if (!uid) return fail(res, 401, "Bitte erneut anmelden.");
      const reportId = String(req.params.reportId);
      if (!ID.test(reportId)) return fail(res, 400, "Ungültige Meeting-ID.");
      if (!(await listening(uid))) {
        // A probe is a question, not a violation: it gets a plain answer.
        if (req.body?.probe === true) return void res.json({ listening: false });
        return fail(res, 403, "Kein Assistent liest mit.", { listening: false });
      }
      if (req.body?.probe === true) return void res.json({ listening: true });

      const push = cleanPush(req.body);
      if (!push) return fail(res, 400, "Ungültige Live-Daten.");

      const at = now();
      const previous = lastPush.get(key(uid, reportId));
      if (previous !== undefined && at - previous < MIN_PUSH_GAP_MS) {
        res.setHeader("Retry-After", "1");
        return fail(res, 429, "Zu schnell.");
      }
      // A new meeting counts against the quota; pushes to a running one never do.
      // Two simultaneous first pushes could both slip in, which costs at most one
      // extra small document that expires by itself.
      const running = await deps.live.listByOwner(uid);
      if (!running.some((doc) => doc.reportId === reportId) && running.filter((doc) => doc.state !== "ended").length >= MAX_MEETINGS) {
        res.setHeader("Retry-After", "60");
        return fail(res, 429, "Zu viele laufende Meetings.");
      }
      const result: { status: "ok" | "noop" | "resync" } = { status: "ok" };
      const stored = await deps.live.mutate(
        key(uid, reportId),
        (current) => {
          const applied = applyPush(current, push, at);
          result.status = applied.status;
          if (applied.status !== "ok" || !applied.doc) return undefined;
          return { ...applied.doc, reportId };
        },
        (doc) => meta(doc, uid),
      );
      if (result.status === "resync") return fail(res, 409, "Bitte vollständig neu senden.", { resync: true });
      if (result.status === "noop") return void res.json({ seq: stored?.seq ?? push.seq, listening: true });

      lastPush.set(key(uid, reportId), at);
      if (lastPush.size > 5000) for (const [k, t] of lastPush) if (at - t > 60_000) lastPush.delete(k);
      res.json({ seq: stored?.seq ?? push.seq, listening: true });
    },
  );

  router.delete("/live/:reportId", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const uid = await identify(req);
    if (!uid) return fail(res, 401, "Bitte erneut anmelden.");
    const reportId = String(req.params.reportId);
    if (!ID.test(reportId)) return fail(res, 400, "Ungültige Meeting-ID.");
    await deps.live.mutate(key(uid, reportId), () => null, { ownerKey: uid, expireAt: new Date(now() + ENDED_TTL) });
    lastPush.delete(key(uid, reportId));
    res.json({ deleted: true });
  });

  router.use((error: { status?: number; type?: string }, _req: Request, res: Response, next: express.NextFunction) => {
    if (error?.type === "entity.too.large" || error?.status === 413) return fail(res, 413, "Live-Daten zu groß.");
    if (typeof error?.status === "number" && error.status >= 400 && error.status < 500) return fail(res, 400, "Ungültige Live-Daten.");
    next(error);
  });
  return router;
}
