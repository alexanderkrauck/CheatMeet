import type { CapturedPhoto, Draft } from "../types";

/** Measure the recorded timeline independently of asynchronous MediaRecorder events. */
export class RecordingClock {
  private accumulated = 0;
  private startedAt: number | null = null;
  constructor(private now: () => number = () => performance.now()) {}
  reset(duration = 0) {
    this.accumulated = duration;
    this.startedAt = null;
  }
  resume() {
    if (this.startedAt === null) this.startedAt = this.now();
  }
  read() {
    return (
      this.accumulated +
      (this.startedAt === null ? 0 : this.now() - this.startedAt)
    );
  }
  pause() {
    this.accumulated = this.read();
    this.startedAt = null;
    return this.accumulated;
  }
}

/** A retry keeps existing uploads, but must not retain deleted or omit new photos. */
export function reconcileDraftPhotos(
  draft: Draft,
  photos: CapturedPhoto[],
): Draft {
  const metadata = photos.map((photo) => ({
    ...draft.report.photos?.find((p) => p.id === photo.id),
    id: photo.id,
    relativeTimeMs: photo.relativeTimeMs,
  }));
  return {
    ...draft,
    photos,
    report: {
      ...draft.report,
      photos: metadata,
      rawPhotoUrls: metadata.map((photo) => photo.driveId || ""),
    },
  };
}
