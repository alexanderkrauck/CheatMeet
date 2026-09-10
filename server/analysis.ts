import express from "express";
import multer from "multer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GoogleGenAI, type File as GeminiFile, type Part } from "@google/genai";
import { createRemoteJWKSet, jwtVerify } from "jose";
import firebaseConfig from "../firebase-applet-config.json";
import {
  MAX_FILE_BYTES,
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
const audioTypes = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
]);

export function createAnalysisRouter(options: Options = {}) {
  const router = express.Router();
  const verifyToken = options.verifyToken || verifyFirebaseToken;
  const sleep =
    options.sleep ||
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const getAi = () => {
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

  const uploadChunkMiddleware = multer({
    dest: options.uploadRoot || tmpdir(),
    limits: { fileSize: 50 * 1024 * 1024 }
  }).single("audio");

  router.post("/transcribe-full", async (req, res) => {
    let uid: string;
    try {
      const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
      if (!match) throw new Error("Missing token");
      uid = await verifyToken(match[1]);
    } catch {
      res.status(401).json({ error: "Bitte erneut anmelden." });
      return;
    }

    let ai: Client | undefined;
    let remote: GeminiFile | undefined;
    let filePath: string | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        uploadChunkMiddleware(req, res, (err) => err ? reject(err) : resolve());
      });

      ai = getAi();
      const file = req.file;

      if (!file || file.size === 0) {
        throw new RequestError(400, "Eine Audioaufnahme ist erforderlich.");
      }

      filePath = file.path;
      remote = await ai.files.upload({
        file: file.path,
        config: { mimeType: file.mimetype }
      });
      
      for (let attempt = 0; remote.state === "PROCESSING" && attempt < (options.processingAttempts ?? 60); attempt++) {
        await sleep(1000);
        remote = await ai.files.get({ name: remote.name });
      }
      
      if (remote.state !== "ACTIVE" || !remote.uri) {
        throw new RequestError(502, "Die KI konnte die Mediendatei nicht verarbeiten.");
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: [
          { 
            role: "user", 
            parts: [
              { fileData: { fileUri: remote.uri, mimeType: remote.mimeType || file.mimetype } },
              { text: "Bitte erstelle ein detailliertes und vollständiges Transkript des bisherigen Meetings. Schreibe einfach nur das Transkript auf, ohne Metatext oder Erklärungen." }
            ] 
          }
        ],
        config: {
          temperature: 0.1,
        }
      });

      res.json({ transcript: response.text?.trim() || "" });
    } catch (error) {
      console.error("Transcribe full error:", error);
      res.status(500).json({ error: "Transkription fehlgeschlagen." });
    } finally {
      if (remote?.name && ai) {
        await ai.files.delete({ name: remote.name }).catch(() => {});
      }
      if (filePath) {
        await rm(filePath, { force: true }).catch(() => {});
      }
    }
  });

  const uploadMiddleware = multer({
    dest: options.uploadRoot || tmpdir(),
    limits: { fileSize: 25 * 1024 * 1024 }
  }).single("audio");

  router.post("/analyze", async (req, res) => {
    let uid: string;
    try {
      const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || "");
      if (!match) throw new Error("Missing token");
      uid = await verifyToken(match[1]);
    } catch {
      res.status(401).json({ error: "Bitte erneut anmelden." });
      return;
    }

    let ai: Client | undefined;
    let remote: GeminiFile | undefined;
    let filePath: string | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        uploadMiddleware(req, res, (err) => err ? reject(err) : resolve());
      });

      ai = getAi();
      const transcription = req.body.transcription;
      const preferences = req.body.preferences || "";
      const file = req.file;

      if (!transcription && !file) {
        throw new RequestError(400, "Weder Audio noch Transkription vorhanden.");
      }

      let systemInstruction = "Du erstellst professionelle Meeting-Zusammenfassungen. Extrahiere einen passenden Titel, ein ausführliches Transkript (falls nicht bereits vorhanden), eine umfassende Zusammenfassung, konkrete Aufgaben (todos) und die wichtigsten Erkenntnisse (takeaways).";
      if (preferences) {
        systemInstruction += `\nBeachte diese Nutzer-Präferenzen für die Zusammenfassung: ${preferences}`;
      }

      const parts: Part[] = [];
      if (transcription) {
        parts.push({ text: transcription });
      }

      if (file) {
        filePath = file.path;
        remote = await ai.files.upload({
          file: file.path,
          config: { mimeType: file.mimetype }
        });
        
        for (let attempt = 0; remote.state === "PROCESSING" && attempt < (options.processingAttempts ?? 60); attempt++) {
          await sleep(1000);
          remote = await ai.files.get({ name: remote.name });
        }
        
        if (remote.state !== "ACTIVE" || !remote.uri) {
          throw new RequestError(502, "Die KI konnte die Mediendatei nicht verarbeiten.");
        }
        
        parts.push({ fileData: { fileUri: remote.uri, mimeType: remote.mimeType || file.mimetype } });
        if (!transcription) {
          parts.push({ text: "Analysiere dieses Meeting-Audio. Erstelle ein detailliertes Transkript und extrahiere die wichtigsten Informationen wie oben beschrieben." });
        }
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
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
      } catch (e) {
        console.error("JSON validation failed:", response.text);
        throw new RequestError(502, "Die KI hat keinen vollständigen Bericht geliefert.");
      }
      res.json(result);
    } catch (error) {
      console.error("Analyze error:", error);
      res.status(error instanceof RequestError ? error.status : 500).json({ error: error instanceof RequestError ? error.message : "Analyse fehlgeschlagen." });
    } finally {
      if (remote?.name && ai) {
        await ai.files.delete({ name: remote.name }).catch(() => {});
      }
      if (filePath) {
        await rm(filePath, { force: true }).catch(() => {});
      }
    }
  });
  return router;
}
