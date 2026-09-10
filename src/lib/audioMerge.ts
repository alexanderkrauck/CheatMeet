export function mergeAudioStreams(stream1: MediaStream, stream2: MediaStream | undefined): MediaStream {
  if (!stream2 || stream2.getAudioTracks().length === 0) return stream1;
  
  const ctx = new window.AudioContext();
  ctx.resume(); // Ensure the context is running
  
  const dest = ctx.createMediaStreamDestination();
  
  if (stream1.getAudioTracks().length > 0) {
    const source1 = ctx.createMediaStreamSource(stream1);
    source1.connect(dest);
  }
  
  if (stream2.getAudioTracks().length > 0) {
    const source2 = ctx.createMediaStreamSource(stream2);
    source2.connect(dest);
  }
  
  return dest.stream;
}