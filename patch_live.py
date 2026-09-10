import re

with open('src/lib/liveTranscription.ts', 'r') as f:
    content = f.read()

new_class = '''
import { driveToken } from "./session";

export class LiveTranscriber {
  private allChunks: Blob[] = [];
  private processing = false;
  private lastProcessTime = 0;
  private onTranscriptUpdated: (newText: string) => void;

  constructor(onTranscriptUpdated: (newText: string) => void) {
    this.onTranscriptUpdated = onTranscriptUpdated;
  }

  addChunk(blob: Blob) {
    this.allChunks.push(blob);
    this.processNext();
  }

  private async processNext() {
    if (this.processing) return;
    
    // Process every 30 seconds
    const now = Date.now();
    if (now - this.lastProcessTime < 30000) return;
    if (this.allChunks.length === 0) return;

    this.processing = true;
    this.lastProcessTime = now;

    const audioBlob = new Blob(this.allChunks, { type: this.allChunks[0].type || "audio/webm" });

    try {
      const token = driveToken();
      if (!token) throw new Error("No token");
      
      const { auth } = await import("./firebase");
      const idToken = await auth.currentUser?.getIdToken();

      const form = new FormData();
      form.append("audio", audioBlob, "full.webm");
      
      const response = await fetch("/api/transcribe-full", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: form,
      });

      if (response.ok) {
        const data = await response.json();
        const newTranscript = data.transcript || "";
        if (newTranscript) {
          this.onTranscriptUpdated(newTranscript);
        }
      }
    } catch (error) {
      console.error("Live transcription failed:", error);
    } finally {
      this.processing = false;
      // Re-evaluate in case 30s passed during processing
      setTimeout(() => this.processNext(), 1000);
    }
  }
}
'''

with open('src/lib/liveTranscription.ts', 'w') as f:
    f.write(new_class.strip())

