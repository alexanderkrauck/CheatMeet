import express from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { verifyFirebaseToken } from "./analysis";
import { MAX_FILE_BYTES, isAudioMimeType } from "../shared/analysis";
import { batchTranscript, validLanguages } from "../shared/transcription";
import {
  fileSubmissionStore,
  firestoreSubmissionStore,
  submissionKey,
  type SubmissionStore,
  type Submission,
} from "./transcriptionStore";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
class ProviderError extends ApiError {
  constructor(public upstreamStatus: number) {
    super(502, `AssemblyAI hat die Anfrage nicht bestätigt (${upstreamStatus}). Die Aufnahme bleibt erhalten.`);
  }
}
// These responses explicitly reject a job; timeouts and 5xx remain uncertain.
const REJECTED = new Set([400, 401, 403, 404, 413, 415, 422, 429]);
export function createTranscriptionRouter(
  options: {
    verifyToken?: typeof verifyFirebaseToken;
    fetchImpl?: typeof fetch;
    store?: SubmissionStore;
    apiKey?: string;
    maxFileBytes?: number;
    uploadRoot?: string;
  } = {},
) {
  const router = express.Router();
  const store =
    options.store ||
    (process.env.NODE_ENV === "production"
      ? firestoreSubmissionStore()
      : fileSubmissionStore());
  const providerFetch = options.fetchImpl || fetch;
  const verify = options.verifyToken || verifyFirebaseToken;
  const key = () => options.apiKey ?? process.env.ASSEMBLYAI_API_KEY;
  router.get("/transcription/config", (_req, res) =>
    res.json({ provider: "assemblyai", configured: Boolean(key()) }),
  );
  const api = async (url: string, init: RequestInit = {}) => {
    if (!key())
      throw new ApiError(
        503,
        "AssemblyAI ist noch nicht eingerichtet. Die Aufnahme bleibt erhalten.",
      );
    const response = await providerFetch(url, {
      ...init,
      headers: { ...init.headers, authorization: key()! },
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new ProviderError(response.status);
    return response.json();
  };
  const base = "https://api.eu.assemblyai.com/v2";
  const owner = async (req: express.Request) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || "")?.[1];
    if (!token) throw new ApiError(401, "Bitte erneut anmelden.");
    try {
      return await verify(token);
    } catch {
      throw new ApiError(401, "Bitte erneut anmelden.");
    }
  };
  const reportId = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
      throw new ApiError(400, "Ungültige Meeting-ID.");
    return value;
  };
  const fail = (res: express.Response, error: unknown, stage = "request") => {
    // Do not expose upstream bodies, upload URLs or keys.
    console.error(JSON.stringify({ event: "transcription_failure", stage,
      status: error instanceof ApiError ? error.status : 503,
      ...(error instanceof ProviderError ? { upstreamStatus: error.upstreamStatus } : {}),
    }));
    res
      .status(error instanceof ApiError ? error.status : 503)
      .json({
        error:
          error instanceof ApiError
            ? error.message
            : "Transkription derzeit nicht verfügbar. Die Aufnahme bleibt erhalten.",
      });
  };
  const bursts = new Map<string, { at: number; count: number }>();
  router.post(
    "/transcription/token",
    express.json({ limit: "4kb" }),
    async (req, res) => {
      try {
        const uid = await owner(req);
        if (!key())
          throw new ApiError(503, "AssemblyAI ist noch nicht eingerichtet.");
        const id = reportId(req.body.reportId);
        const { source, session, languages } = req.body;
        if (
          !["mic", "system"].includes(source) ||
          !Number.isSafeInteger(session) ||
          session < 0 ||
          session > 10000 ||
          !validLanguages(languages)
        )
          throw new ApiError(400, "Ungültige Streaming-Einstellungen.");
        const recent = bursts.get(uid);
        if (recent && Date.now() - recent.at < 60000 && recent.count >= 12)
          throw new ApiError(
            429,
            "Zu viele Verbindungsversuche. Aufnahme läuft weiter; finales Transkript folgt beim Abschluss.",
          );
        if (!recent || Date.now() - recent.at >= 60000)
          bursts.set(uid, { at: Date.now(), count: 1 });
        else recent.count++;
        for (const [user, value] of bursts)
          if (Date.now() - value.at > 60000) bursts.delete(user);
        const value: Submission = {
          state: "reserved",
          languages,
          createdAt: new Date().toISOString(),
        };
        if (
          !(await store.reserve(
            submissionKey(uid, `${id}:live:${source}:${session}`),
            value,
          ))
        )
          throw new ApiError(
            409,
            "Diese Live-Verbindung wurde bereits angefordert und wird nicht wiederholt.",
          );
        const data = await api(
          "https://streaming.eu.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=10800",
        );
        if (typeof data.token !== "string")
          throw new ApiError(502, "Kein Streaming-Token erhalten.");
        res.setHeader("Cache-Control", "no-store");
        res.json({ token: data.token });
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get("/transcription/final/:id", async (req, res) => {
    try {
      const uid = await owner(req);
      const job = await store.get(
        submissionKey(uid, `${reportId(req.params.id)}:final`),
      );
      if (!job) {
        res.status(404).json({ state: "missing" });
        return;
      }
      if (job.state === "retryable") {
        res.setHeader("Cache-Control", "no-store");
        res.json({ state: "retryable" });
        return;
      }
      if (!job.providerId)
        throw new ApiError(
          409,
          "Der letzte Auftrag ist unbestätigt. Kein erneutes Senden, damit Audio höchstens zweimal transkribiert wird. Die Originalaufnahme bleibt erhalten.",
        );
      const data = await api(
        `${base}/transcript/${encodeURIComponent(job.providerId)}`,
      );
      res.setHeader("Cache-Control", "no-store");
      if (data.status === "error")
        throw new ApiError(
          422,
          "Der finale Transkriptionsauftrag ist fehlgeschlagen. Die Originalaufnahme bleibt erhalten; kein automatischer weiterer Durchlauf.",
        );
      if (data.status !== "completed") {
        res.json({ state: "processing" });
        return;
      }
      if (
        data.speech_model_used &&
        data.speech_model_used !== "universal-3-5-pro"
      )
        throw new ApiError(
          502,
          "Der Transkriptionsanbieter hat ein anderes Modell verwendet.",
        );
      // Provider job remains readable for restart/cross-device recovery. Retention
      // is configured at the provider, not silently deleted before durable export.
      res.json({
        state: "completed",
        speech: batchTranscript(data, job.languages),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  const receive = multer({
    dest: options.uploadRoot || tmpdir(),
    limits: {
      fileSize: Math.min(
        options.maxFileBytes ?? MAX_FILE_BYTES,
        30 * 1024 * 1024,
      ),
      fields: 2,
      fieldSize: 4096,
      files: 1,
    },
  }).single("audio");
  router.post(
    "/transcription/final/:id",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      let stream: Readable | undefined;
      let input: Readable | undefined;
      let reserved: { key: string; job: Submission } | undefined;
      let stage: "request" | "upload" | "submit" | "checkpoint" = "request";
      try {
        const uid = await owner(req);
        if (!key())
          throw new ApiError(
            503,
            "AssemblyAI ist noch nicht eingerichtet. Die Aufnahme bleibt erhalten.",
          );
        const id = reportId(req.params.id);
        const storageKey = submissionKey(uid, `${id}:final`);
        const existing = await store.get(storageKey);
        if (existing && existing.state !== "retryable") {
          res.status(202).json({ state: "existing" });
          return;
        }
        const fromDrive = req.is("application/json");
        let languages: unknown;
        if (fromDrive) {
          const { driveFileId, driveAccessToken } = req.body;
          if (
            typeof driveFileId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,200}$/.test(driveFileId) ||
            typeof driveAccessToken !== "string" ||
            !driveAccessToken ||
            driveAccessToken.length > 4096
          )
            throw new ApiError(400, "Drive-Datei oder Freigabe fehlt.");
          languages = req.body.languages;
        } else {
          await new Promise<void>((resolve, reject) =>
            receive(req, res, (error) =>
              error
                ? reject(
                    new ApiError(
                      (error as any).code === "LIMIT_FILE_SIZE" ? 413 : 400,
                      "Audio-Upload fehlgeschlagen. Größere Aufnahmen zuerst in Drive sichern.",
                    ),
                  )
                : resolve(),
            ),
          );
          if (!req.file?.size || !isAudioMimeType(req.file.mimetype))
            throw new ApiError(
              415,
              "Eine unterstützte Audioaufnahme ist erforderlich.",
            );
          try {
            languages = JSON.parse(req.body.languages || "null");
          } catch {
            /* validated below */
          }
        }
        if (!validLanguages(languages))
          throw new ApiError(400, "Bitte die erwarteten Sprachen auswählen.");
        const job: Submission = {
          state: "reserved",
          languages,
          createdAt: new Date().toISOString(),
        };
        if (fromDrive) {
          // The only credential sent to Google is the caller's short-lived Drive
          // grant. Neither that credential nor a private Drive URL reaches ASR.
          const media = await providerFetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(req.body.driveFileId)}?alt=media`,
            {
              headers: { Authorization: `Bearer ${req.body.driveAccessToken}` },
              signal: AbortSignal.timeout(300000),
            },
          );
          if (!media.ok || !media.body)
            throw new ApiError(
              502,
              "Die gesicherte Drive-Aufnahme konnte nicht gelesen werden.",
            );
          input = Readable.fromWeb(media.body as any);
        } else input = createReadStream(req.file!.path);
        if (!(await (existing ? store.retry(storageKey, job) : store.reserve(storageKey, job)))) {
          res.status(202).json({ state: "existing" });
          return;
        }
        reserved = { key: storageKey, job };
        stage = "upload";
        const source = input;
        const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
        stream = Readable.from(
          (async function* () {
            let bytes = 0;
            for await (const chunk of source) {
              bytes += chunk.length;
              if (bytes > maxBytes)
                throw new ApiError(413, "Die Audiodatei ist zu groß.");
              yield chunk;
            }
            if (!bytes) throw new ApiError(400, "Die Audiodatei ist leer.");
          })(),
        );
        const upload = await api(`${base}/upload`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: stream as any,
          duplex: "half",
        } as RequestInit);
        if (typeof upload.upload_url !== "string")
          throw new ApiError(502, "Audio-Upload wurde nicht bestätigt.");
        const languageSettings =
          languages.length === 1
            ? { language_code: languages[0] }
            : { language_detection: true };
        // Pro handles multilingual speech natively. language_codes selects the
        // legacy code-switching mode and cannot accompany language_detection.
        // No retry around this POST. Persist the reservation BEFORE it, including
        // uncertain transport failure, so another process cannot create pass three.
        stage = "submit";
        const submitted = await api(`${base}/transcript`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            audio_url: upload.upload_url,
            speech_models: ["universal-3-5-pro"],
            ...languageSettings,
            speaker_labels: true,
            punctuate: true,
            format_text: true,
            remove_audio_tags: "all",
          }),
        });
        if (typeof submitted.id !== "string")
          throw new ApiError(
            502,
            "Transkriptionsauftrag wurde nicht bestätigt.",
          );
        stage = "checkpoint";
        await store.set(storageKey, {
          ...job,
          state: "submitted",
          providerId: submitted.id,
        });
        res.status(202).json({ state: "processing" });
      } catch (error) {
        if (reserved && (stage === "upload" || (stage === "submit" && error instanceof ProviderError && REJECTED.has(error.upstreamStatus)))) {
          // Uploading alone never starts ASR. Explicit submission rejection also
          // leaves the final pass unused. Persist that evidence before retrying.
          await store.set(reserved.key, { ...reserved.job, state: "retryable", failureStage: stage as "upload" | "submit",
            ...(error instanceof ProviderError ? { upstreamStatus: error.upstreamStatus } : {}),
          }).catch(() => {}); // On store failure the old reservation stays closed.
        }
        fail(res, error, stage);
      } finally {
        stream?.destroy();
        input?.destroy();
        if (req.file) await rm(req.file.path, { force: true }).catch(() => {});
      }
    },
  );
  return router;
}
