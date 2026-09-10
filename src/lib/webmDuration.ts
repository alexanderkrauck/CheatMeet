/**
 * MediaRecorder streams WebM live, so it never writes the Segment's `Duration`
 * element: the length is unknown until recording stops. Players therefore
 * cannot seek or scrub the file, and `<audio>` reports an infinite duration.
 *
 * Chrome leaves no spare `Void` element to overwrite — `Info` holds exactly
 * TimecodeScale, MuxingApp and WritingApp — so `Duration` is inserted and
 * `Info`'s size is rewritten. That shifts everything after it, which is safe
 * here because the Segment has unknown size and the recorder emits no SeekHead
 * or Cues that would carry stale absolute offsets.
 *
 * Anything unexpected returns the original blob: an unseekable recording is far
 * better than a corrupted one.
 */
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

/** Widest Segment size, meaning "unknown" in a live stream. */
const UNKNOWN_SIZE = 0x00ffffffffffff;

interface Cursor {
  view: DataView;
  at: number;
}

function readVint(cursor: Cursor, keepMarker: boolean) {
  const first = cursor.view.getUint8(cursor.at);
  let width = 1;
  while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
  if (width > 8) throw new Error("Invalid EBML width");
  let value = keepMarker ? first : first & (0xff >> width);
  for (let i = 1; i < width; i++)
    value = value * 256 + cursor.view.getUint8(cursor.at + i);
  cursor.at += width;
  return value;
}

const readId = (cursor: Cursor) => readVint(cursor, true);
const readSize = (cursor: Cursor) => readVint(cursor, false);

/** Encodes a length as an EBML variable-length integer, narrowest first. */
function encodeSize(value: number): Uint8Array {
  for (let width = 1; width <= 8; width++) {
    // The all-ones value at a given width is reserved for "unknown".
    if (value >= 2 ** (7 * width) - 1) continue;
    const bytes = new Uint8Array(width);
    let rest = value;
    for (let i = width - 1; i >= 0; i--) {
      bytes[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    bytes[0] |= 0x80 >> (width - 1);
    return bytes;
  }
  throw new Error("Length too large");
}

interface InfoElement {
  idStart: number;
  bodyStart: number;
  size: number;
}

function findInfo(view: DataView, limit: number): InfoElement | null {
  const cursor: Cursor = { view, at: 0 };
  while (cursor.at < limit - 12) {
    const id = readId(cursor);
    const size = readSize(cursor);
    if (id !== SEGMENT) {
      cursor.at += size;
      continue;
    }
    // Descend into Segment rather than skipping it; Info lives inside.
    const end = size >= UNKNOWN_SIZE ? limit : Math.min(limit, cursor.at + size);
    while (cursor.at < end - 5) {
      const idStart = cursor.at;
      const childId = readId(cursor);
      const childSize = readSize(cursor);
      if (childId === INFO)
        return { idStart, bodyStart: cursor.at, size: childSize };
      cursor.at += childSize;
    }
    return null;
  }
  return null;
}

/**
 * Writes `durationMs` into a WebM produced by MediaRecorder so the file can be
 * seeked. Returns the original blob when it is already seekable or the layout
 * is not what we expect.
 */
export async function withWebmDuration(
  blob: Blob,
  durationMs: number,
): Promise<Blob> {
  if (!(durationMs > 0) || !/webm|matroska/i.test(blob.type)) return blob;
  try {
    // The header sits at the front; there is no need to read an hour of audio.
    const head = new Uint8Array(await blob.slice(0, 65_536).arrayBuffer());
    const view = new DataView(head.buffer);
    const info = findInfo(view, head.byteLength);
    if (!info || info.bodyStart + info.size > head.byteLength) return blob;

    const bodyEnd = info.bodyStart + info.size;
    const cursor: Cursor = { view, at: info.bodyStart };
    let scale = 1_000_000;
    while (cursor.at < bodyEnd - 1) {
      const id = readId(cursor);
      const size = readSize(cursor);
      if (id === DURATION) return blob; // Already seekable.
      if (id === TIMECODE_SCALE) {
        scale = 0;
        for (let i = 0; i < size; i++) scale = scale * 256 + head[cursor.at + i];
      }
      cursor.at += size;
    }

    // 2 byte id, 1 byte length, 8 byte float.
    const duration = new Uint8Array(11);
    const out = new DataView(duration.buffer);
    out.setUint8(0, 0x44);
    out.setUint8(1, 0x89);
    out.setUint8(2, 0x88);
    out.setFloat64(3, (durationMs * 1_000_000) / (scale || 1_000_000));

    const idBytes = head.slice(info.idStart, info.bodyStart - 0);
    // Rebuild the Info header with its new length.
    const idOnly = head.slice(info.idStart, info.idStart + idLength(idBytes));
    const size = encodeSize(info.size + duration.byteLength);

    return new Blob(
      [
        head.slice(0, info.idStart),
        idOnly,
        size,
        head.slice(info.bodyStart, bodyEnd),
        duration,
        blob.slice(bodyEnd),
      ],
      { type: blob.type },
    );
  } catch {
    return blob;
  }
}

/** Length in bytes of the leading EBML id inside a header slice. */
function idLength(header: Uint8Array): number {
  const first = header[0];
  let width = 1;
  while (width <= 4 && !(first & (0x80 >> (width - 1)))) width++;
  return width;
}
