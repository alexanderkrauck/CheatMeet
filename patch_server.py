import re

with open('server/analysis.ts', 'r') as f:
    content = f.read()

# Replace /transcribe-chunk with /transcribe-full
old_route = r'router\.post\("/transcribe-chunk".*?\}\s*\);'

new_route = '''
  const uploadChunkMiddleware = multer({
    dest: options.uploadRoot || tmpdir(),
    limits: { fileSize: 50 * 1024 * 1024 }
  }).single("audio");

  router.post("/transcribe-full", async (req, res) => {
    let uid: string;
    try {
      const match = /^Bearer (\\S+)$/i.exec(req.headers.authorization || "");
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
        model: "gemini-2.5-flash",
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
'''

# Use regex to find and replace the block
match = re.search(r'router\.post\("/transcribe-chunk".*?res\.status\(500\)\.json\(\{ error: "Chunk-Transkription fehlgeschlagen\." \}\);\s*\}\s*finally\s*\{.*?\n\s*\}\s*\}\);', content, flags=re.DOTALL)
if match:
    content = content.replace(match.group(0), new_route.strip())
    with open('server/analysis.ts', 'w') as f:
        f.write(content)
else:
    print("Match not found for /transcribe-chunk!")

