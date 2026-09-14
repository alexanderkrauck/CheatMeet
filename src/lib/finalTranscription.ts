import { auth } from "./firebase";
import { putDraft, putLocal } from "./local";
import { audioExtension } from "../../shared/analysis";
import {
  renderTranscript,
  type MeetingTranscript,
} from "../../shared/transcription";
import { withWebmDuration } from "./webmDuration";
import type { Draft } from "../types";
import { ensureDriveToken } from "./session";

const active = new Map<string, Promise<void>>();
/** Final result is checkpointed before summary generation. Retry only polls the
 * same server-owned job; uncertain POSTs never trigger a second final pass. */
export function ensureFinalTranscript(
  draft: Draft,
  driveToken?: string,
): Promise<void> {
  if (!draft.report.speech || draft.report.speech.phase === "final")
    return Promise.resolve();
  const owner = auth.currentUser?.uid;
  if (!owner) return Promise.reject(new Error("Bitte erneut anmelden."));
  const key = `${owner}:${draft.report.id}`;
  const assertOwner = () => {
    if (auth.currentUser?.uid !== owner)
      throw new Error("Das angemeldete Konto hat sich geändert.");
  };
  const existing = active.get(key);
  if (existing)
    return existing.then(async () => {
      // Concurrent callers may hold different Draft objects. Re-read the result,
      // instead of letting one caller summarize its old provisional copy.
      const { getDraft } = await import("./local");
      const stored = await getDraft(owner, draft.report.id);
      assertOwner();
      if (stored?.report.speech?.phase !== "final")
        throw new Error("Finales Transkript fehlt.");
      draft.report = {
        ...draft.report,
        speech: stored.report.speech,
        transcription: stored.report.transcription,
      };
    });
  const run = async () => {
    const url = `/api/transcription/final/${encodeURIComponent(draft.report.id)}`;
    const request = async (init: RequestInit = {}) => {
      assertOwner();
      const token = await auth.currentUser!.getIdToken();
      assertOwner();
      const response = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(300000),
      });
      assertOwner();
      const data = await response.json();
      assertOwner();
      if (!response.ok && response.status !== 404)
        throw new Error(data.error || "Finale Transkription fehlgeschlagen.");
      return { response, data };
    };
    let { response, data } = await request();
    if (response.status === 404) {
      if (draft.report.rawAudioUrl) {
        const access = driveToken || (await ensureDriveToken());
        assertOwner();
        if (!access) throw new Error("Bitte Google Drive erneut verbinden.");
        ({ data } = await request({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driveFileId: draft.report.rawAudioUrl,
            driveAccessToken: access,
            languages: draft.report.speech!.languages,
          }),
        }));
      } else {
        if (!draft.audio)
          throw new Error(
            "Für das finale Transkript fehlt die Originalaufnahme.",
          );
        if (draft.audio.size > 30 * 1024 * 1024)
          throw new Error("Diese Aufnahme bitte zuerst in Drive sichern.");
        const audio = await withWebmDuration(
          draft.audio,
          draft.report.durationMs || 0,
        );
        assertOwner();
        const form = new FormData();
        form.append("audio", audio, `recording.${audioExtension(audio.type)}`);
        form.append(
          "languages",
          JSON.stringify(draft.report.speech!.languages),
        );
        ({ data } = await request({ method: "POST", body: form }));
      }
    }
    const deadline = Date.now() + 30 * 60 * 1000;
    while (data.state !== "completed") {
      if (Date.now() >= deadline)
        throw new Error(
          "Das finale Transkript braucht länger. Später erneut öffnen; der bestehende Auftrag wird weiter abgefragt.",
        );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      ({ data } = await request());
    }
    const speech = data.speech as MeetingTranscript;
    if (
      speech?.provider !== "assemblyai" ||
      speech.phase !== "final" ||
      !Array.isArray(speech.turns) ||
      speech.turns.some((t) => !t.final || typeof t.text !== "string")
    )
      throw new Error("Kein finales Transkript erhalten.");
    // Batch identities are independent from live identities: never equate their
    // letters or guess a name mapping. Final names are editable in the report.
    draft.report = {
      ...draft.report,
      speech,
      transcription: renderTranscript(speech),
    };
    assertOwner();
    await putDraft(owner, draft);
    assertOwner();
    await putLocal(owner, draft.report);
    assertOwner();
  };
  const result = run().finally(() => active.delete(key));
  active.set(key, result);
  return result;
}
