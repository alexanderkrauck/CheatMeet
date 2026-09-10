import express from "express";
import multer from "multer";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GoogleGenAI, type File as GeminiFile, type Part } from "@google/genai";
import { createRemoteJWKSet, jwtVerify } from "jose";
import firebaseConfig from "../firebase-applet-config.json";
import {
  MAX_FILE_BYTES,
  MAX_SEGMENT_BYTES,
  MAX_TRANSCRIPT_CONTEXT_CHARS,
  isAudioMimeType,
  reportSchema,
  validateAnalysis,
} from "../shared/analysis";

const keys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);
export async function verifyFirebaseToken(token: string): Promise<string> {
  const projectId = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId;
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });
  if (
    !payload.sub ||
    payload.sub.length > 128 ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time > Date.now() / 1000
  )
    throw new Error("Invalid Firebase identity");
  return payload.sub;
}

type Client = Pick<GoogleGenAI, "files" | "models">;
type Options = {
  verifyToken?: (token: string) => Promise<string>;
  createClient?: () => Client;
  sleep?: (ms: number) => Promise<void>;
  maxFileBytes?: number;
  maxSegmentBytes?: number;
  processingAttempts?: number;
  uploadRoot?: string;
};

class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const analysisModel = () => process.env.GEMINI_MODEL || "gemini-3.6-flash";
const fastModel = () =>
  process.env.GEMINI_FAST_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash";

const continuationSchema = {
  type: "object",
  required: ["continuation"],
  properties: { continuation: { type: "string" } },
};

export function createAnalysisRouter(options: Options = {}) {
  const router = express.Router();
  const verifyToken = options.verifyToken || verifyFirebaseToken;
  const sleep =
    options.sleep ||
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxSegmentBytes = options.maxSegmentBytes ?? MAX_SEGMENT_BYTES;
  // One expensive analysis per user at a time; segment transcription is already
  // serialized by the recording client and must not be blocked by it.
  const analysing = new Set<string>();

  const getAi = (): Client => {
    if (!options.createClient && !process.env.GEMINI_API_KEY)
      throw new RequestError(
        503,
        "KI ist noch nicht eingerichtet. GEMINI_API_KEY in den Server-Secrets hinterlegen.",
      );
    return options.createClient
      ? options.createClient()
      : new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY!,
          httpOptions: { timeout: 180_000 },
        });
  };

  async function authenticate(req: express.Request): Promise<string> {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
    if (!match) throw new RequestError(401, "Bitte erneut anmelden.");
    try {
      return await verifyToken(match[1]);
    } catch {
      throw new RequestError(401, "Bitte erneut anmelden.");
    }
  }

  const receive = (limit: number) => {
    const middleware = multer({
      dest: options.uploadRoot || tmpdir(),
      limits: { fileSize: limit },
    }).single("audio");
    return (req: express.Request, res: express.Response) =>
      new Promise<void>((resolve, reject) =>
        middleware(req, res, (error) => {
          if (!error) return resolve();
          reject(
            (error as { code?: string }).code === "LIMIT_FILE_SIZE"
              ? new RequestError(413, "Die Audiodatei ist zu groß.")
              : new RequestError(400, "Der Upload konnte nicht gelesen werden."),
          );
        }),
      );
  };

  /**
   * Hands a local audio file to Gemini and waits until it is usable. The remote
   * handle is reported as soon as it exists so that a file which never becomes
   * active is still deleted rather than left behind on the provider.
   */
  async function uploadMedia(
    ai: Client,
    file: Express.Multer.File,
    track: (remote: GeminiFile) => void,
  ): Promise<GeminiFile> {
    let remote = await ai.files.upload({
      file: file.path,
      config: { mimeType: file.mimetype },
    });
    track(remote);
    for (
      let attempt = 0;
      remote.state === "PROCESSING" &&
      attempt < (options.processingAttempts ?? 60);
      attempt++
    ) {
      await sleep(1000);
      remote = await ai.files.get({ name: remote.name });
      track(remote);
    }
    if (remote.state !== "ACTIVE" || !remote.uri)
      throw new RequestError(502, "Die KI konnte die Mediendatei nicht verarbeiten.");
    return remote;
  }

  function requireAudio(
    file: Express.Multer.File | undefined,
  ): Express.Multer.File {
    if (!file || !file.size)
      throw new RequestError(400, "Eine Audioaufnahme ist erforderlich.");
    if (!isAudioMimeType(file.mimetype))
      throw new RequestError(415, "Dieses Audioformat wird nicht unterstützt.");
    return file;
  }

  function fail(res: express.Response, error: unknown, context: string) {
    if (!(error instanceof RequestError)) console.error(`${context}:`, error);
    res
      .status(error instanceof RequestError ? error.status : 500)
      .json({
        error:
          error instanceof RequestError
            ? error.message
            : "Die Verarbeitung ist fehlgeschlagen.",
      });
  }

  // Each segment overlaps the previous one, so the model is asked to return only
  // the part that is genuinely new. Returning a continuation instead of a rewritten
  // full transcript keeps this call's cost flat as the meeting grows.
  router.post("/transcribe-segment", async (req, res) => {
    let ai: Client | undefined;
    let remote: GeminiFile | undefined;
    let filePath: string | undefined;
    try {
      await authenticate(req);
      await receive(maxSegmentBytes)(req, res);
      // Record the temporary path before validating, so a rejected upload is
      // still removed from disk.
      if (req.file) filePath = req.file.path;
      const file = requireAudio(req.file);
      const previous = String(req.body.previousTranscript || "").slice(
        -MAX_TRANSCRIPT_CONTEXT_CHARS,
      );

      ai = getAi();
      remote = await uploadMedia(ai, file, (f) => (remote = f));
      const raw = (
        await ai.models.generateContent({
          model: fastModel(),
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    fileUri: remote.uri!,
                    mimeType: remote.mimeType || file.mimetype,
                  },
                },
                {
                  text: "Transkribiere diese Audioaufnahme wortgetreu. Gib ausschließlich das Transkript aus, ohne Einleitung, Zeitstempel oder Erklärungen.",
                },
              ],
            },
          ],
          config: { temperature: 0 },
        })
      ).text?.trim();

      if (!raw) {
        res.json({ text: "" });
        return;
      }
      if (!previous) {
        res.json({ text: raw });
        return;
      }

      const glued = await ai.models.generateContent({
        model: fastModel(),
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Bisheriges Transkript (Ende):\n"""\n${previous}\n"""\n\nNeues Transkript des nächsten Abschnitts, dessen Anfang sich mit dem Ende des bisherigen Transkripts überschneidet:\n"""\n${raw}\n"""\n\nGib ausschließlich den Teil des neuen Abschnitts zurück, der noch nicht im bisherigen Transkript enthalten ist. Entferne die Überschneidung vollständig, korrigiere offensichtliche Transkriptionsfehler und ändere sonst nichts am Wortlaut. Wenn der Abschnitt nichts Neues enthält, gib einen leeren Text zurück.`,
              },
            ],
          },
        ],
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: continuationSchema,
        },
      });

      let continuation: string;
      try {
        const parsed = JSON.parse(glued.text || "");
        if (typeof parsed?.continuation !== "string") throw new Error("shape");
        continuation = parsed.continuation;
      } catch {
        // Losing the overlap is recoverable for the reader; losing speech is not.
        console.error("Segment glue returned unusable output:", glued.text);
        continuation = raw;
      }
      res.json({ text: continuation.trim() });
    } catch (error) {
      fail(res, error, "Transcribe segment error");
    } finally {
      if (remote?.name && ai)
        await ai.files.delete({ name: remote.name }).catch(() => {});
      if (filePath) await rm(filePath, { force: true }).catch(() => {});
    }
  });

  // The report is normally built from the transcript the recording already
  // assembled. Audio is only uploaded when there is no transcript at all,
  // which is the case for an imported file.
  router.post("/analyze", async (req, res) => {
    let uid: string | undefined;
    let acquired = false;
    let ai: Client | undefined;
    let remote: GeminiFile | undefined;
    let filePath: string | undefined;
    try {
      uid = await authenticate(req);
      await receive(maxFileBytes)(req, res);
      if (req.file) filePath = req.file.path;

      // Only the request that actually took the slot may release it.
      if (analysing.has(uid))
        throw new RequestError(
          429,
          "Es läuft bereits eine Analyse. Bitte kurz warten.",
        );
      analysing.add(uid);
      acquired = true;

      const transcription = String(req.body.transcription || "").trim();
      const preferences = String(req.body.preferences || "").trim();
      if (!transcription && !req.file)
        throw new RequestError(400, "Weder Audio noch Transkription vorhanden.");

      let systemInstruction =
        "Du erstellst professionelle Meeting-Zusammenfassungen. Extrahiere einen passenden Titel, ein ausführliches Transkript (falls nicht bereits vorhanden), eine umfassende Zusammenfassung, konkrete Aufgaben (todos) und die wichtigsten Erkenntnisse (takeaways).";
      if (preferences)
        systemInstruction += `\nBeachte diese Nutzer-Präferenzen für die Zusammenfassung: ${preferences}`;

      const parts: Part[] = [];
      if (transcription) parts.push({ text: transcription });
      if (!transcription) {
        const file = requireAudio(req.file);
        ai = getAi();
        remote = await uploadMedia(ai, file, (f) => (remote = f));
        parts.push({
          fileData: {
            fileUri: remote.uri!,
            mimeType: remote.mimeType || file.mimetype,
          },
        });
        parts.push({
          text: "Analysiere dieses Meeting-Audio. Erstelle ein detailliertes Transkript und extrahiere die wichtigsten Informationen wie oben beschrieben.",
        });
      }

      if (!ai) ai = getAi();
      const response = await ai.models.generateContent({
        model: analysisModel(),
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction,
          temperature: 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: reportSchema,
        },
      });

      let result;
      try {
        result = validateAnalysis(JSON.parse(response.text || ""));
      } catch {
        console.error("Analysis validation failed:", response.text);
        throw new RequestError(
          502,
          "Die KI hat keinen vollständigen Bericht geliefert.",
        );
      }
      // A transcript supplied by the recording is authoritative over any
      // shortened version the summarising model may echo back.
      res.json(transcription ? { ...result, transcription } : result);
    } catch (error) {
      fail(res, error, "Analyze error");
    } finally {
      if (uid && acquired) analysing.delete(uid);
      if (remote?.name && ai)
        await ai.files.delete({ name: remote.name }).catch(() => {});
      if (filePath) await rm(filePath, { force: true }).catch(() => {});
    }
  });

  return router;
}
