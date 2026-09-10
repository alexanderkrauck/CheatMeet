export interface MergedAudio {
  stream: MediaStream;
  /** Releases the mixing graph. Source tracks stay under the caller's control. */
  dispose: () => void;
}

/**
 * Mixes the microphone with optional system audio into one recordable stream.
 *
 * The returned stream is a synthetic AudioContext destination whenever mixing
 * happens, so callers must keep the original streams to stop their tracks and
 * to observe device interruptions.
 */
export function mergeAudioStreams(
  microphone: MediaStream,
  system: MediaStream | undefined,
): MergedAudio {
  if (!system?.getAudioTracks().length)
    return { stream: microphone, dispose: () => {} };

  const context = new AudioContext();
  void context.resume().catch(() => {});
  const destination = context.createMediaStreamDestination();
  for (const source of [microphone, system])
    if (source.getAudioTracks().length)
      context.createMediaStreamSource(source).connect(destination);

  return {
    stream: destination.stream,
    dispose: () => {
      for (const track of destination.stream.getTracks()) track.stop();
      void context.close().catch(() => {});
    },
  };
}
