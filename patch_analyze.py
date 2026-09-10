import re

with open('server/analysis.ts', 'r') as f:
    content = f.read()

old_analyze_body = r'router\.post\("/analyze", express\.json.*?res\.status\(500\)\.json\(\{ error: "Analyse fehlgeschlagen\." \}\);\s*\}\s*\}\);'
match = re.search(old_analyze_body, content, flags=re.DOTALL)
if match:
    old_text = match.group(0)
    new_route = '''
  const uploadMiddleware = multer({
    dest: options.uploadRoot || tmpdir(),
    limits: { fileSize: 25 * 1024 * 1024 }
  }).single("audio");

  router.post("/analyze", async (req, res) => {
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
        systemInstruction += `\\nBeachte diese Nutzer-Präferenzen für die Zusammenfassung: ${preferences}`;
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
        model: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
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
      res.status(500).json({ error: "Analyse fehlgeschlagen." });
    } finally {
      if (remote?.name && ai) {
        await ai.files.delete({ name: remote.name }).catch(() => {});
      }
      if (filePath) {
        await rm(filePath, { force: true }).catch(() => {});
      }
    }
  });'''
    content = content.replace(old_text, new_route.strip())
    with open('server/analysis.ts', 'w') as f:
        f.write(content)
else:
    print("Match not found")

