import type { CapturedPhoto } from "../types";

// Cloud Run HTTP/1 caps request bodies at 32 MiB. Leave room for multipart framing.
export const MAX_ANALYSIS_BYTES = 30 * 1024 * 1024;
export const MULTIPART_RESERVE = 512 * 1024;
export function photoBudget(audioBytes: number, photoCount: number) {
  const remaining = MAX_ANALYSIS_BYTES - MULTIPART_RESERVE - audioBytes;
  if (remaining <= 0)
    throw new Error(
      "Die Audioaufnahme ist zu groß für die Analyse. Bitte eine kürzere Aufnahme verwenden.",
    );
  return photoCount ? Math.floor(remaining / photoCount) : remaining;
}
export async function resizeForAnalysis(
  blob: Blob,
  budget: number,
): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const source = new Image();
    source.src = url;
    await source.decode();
    if (!source.naturalWidth || !source.naturalHeight)
      throw new Error(
        "Ein Foto konnte nicht gelesen werden. Bitte neu hinzufügen.",
      );
    // Analysis copies retain visual context; originals in Drive are never modified.
    let maxSide = 1600;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(
        1,
        maxSide / Math.max(source.naturalWidth, source.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error(
          "Die Fotoverarbeitung wird in diesem Browser nicht unterstützt.",
        );
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const result = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(
                  new Error(
                    "Foto konnte nicht für die Analyse vorbereitet werden.",
                  ),
                ),
          "image/jpeg",
          attempt < 2 ? 0.8 : 0.65,
        ),
      );
      canvas.width = canvas.height = 1;
      if (result.size <= budget) return result;
      maxSide = Math.round(maxSide * 0.75);
    }
    throw new Error(
      "Die Fotos sind zusammen zu groß für die Analyse. Bitte weniger Fotos oder eine kürzere Aufnahme verwenden. Die Originale bleiben in Drive.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function prepareAnalysisPhotos(
  audio: Blob,
  photos: CapturedPhoto[],
  resize = resizeForAnalysis,
) {
  const budget = photoBudget(audio.size, photos.length);
  const prepared: CapturedPhoto[] = [];
  // Decode one image at a time to bound memory on mobile devices.
  for (const photo of photos)
    prepared.push({ ...photo, blob: await resize(photo.blob, budget) });
  if (
    audio.size +
      prepared.reduce((sum, p) => sum + p.blob.size, 0) +
      MULTIPART_RESERVE >
    MAX_ANALYSIS_BYTES
  )
    throw new Error(
      "Die Aufnahme überschreitet die maximale Größe für die Analyse.",
    );
  return prepared;
}
