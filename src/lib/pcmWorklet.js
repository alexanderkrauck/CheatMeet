// @ts-nocheck
// Media-thread PCM capture: no timers and no WebM container slicing.
class MeetingPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.fraction = 0;
    this.sum = 0;
    this.weight = 0;
    this.values = [];
    this.port.onmessage = ({ data }) => {
      this.active = data.active === true;
      this.values = [];
      this.fraction = this.sum = this.weight = 0;
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    const ratio = sampleRate / 16000;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      // Integrate each input sample over its overlap with the output sample.
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, ratio - this.weight);
        this.sum += value * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= ratio - 1e-9) {
          const sample = Math.max(-1, Math.min(1, this.sum / ratio));
          this.values.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
          this.sum = this.weight = 0;
          if (this.values.length === 1600) {
            const pcm = new Int16Array(this.values);
            this.port.postMessage(
              {
                pcm: pcm.buffer,
                contextTime: currentTime + (i + 1) / sampleRate,
              },
              [pcm.buffer],
            );
            this.values = [];
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("meeting-pcm", MeetingPCM);
