import { PcmEncoder } from './pcm';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class MonoPcmProcessor extends AudioWorkletProcessor {
  private credits = 0;
  private sequence = 0;
  private readonly encoder = new PcmEncoder(sampleRate, (pcm, rms) => {
    this.sequence += 1;
    if (this.credits < 1) return;
    this.credits -= 1;
    this.port.postMessage({ pcm, rms, sequence: this.sequence, contextTime: currentTime }, [pcm]);
  });

  constructor() {
    super();
    this.port.onmessage = event => { this.credits = Math.min(8, this.credits + Number(event.data)); };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const channels = inputs[0];
    const length = outputs[0][0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.encoder.push(channels.length ? sample / channels.length : 0);
    }
    // The worklet's output stays silent. Playback has its own direct stereo path.
    return true;
  }
}
registerProcessor('horisub-pcm', MonoPcmProcessor);
