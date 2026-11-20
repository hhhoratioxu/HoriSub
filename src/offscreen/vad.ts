import { FRAME_SAMPLES } from './pcm';

interface VadModule {
  HEAP16: Int16Array;
  _fvad_new(): number;
  _fvad_set_sample_rate(handle: number, rate: number): number;
  _fvad_set_mode(handle: number, mode: number): number;
  _fvad_process(handle: number, pointer: number, length: number): number;
  _fvad_reset(handle: number): void;
  _fvad_free(handle: number): void;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
}
type VadFactory = (options: { wasmBinary: ArrayBuffer }) => Promise<VadModule>;
const VAD_SAMPLES = FRAME_SAMPLES / 6; // 20 ms at 8 kHz, twice per input frame.

export class VoiceDetection {
  private readonly handle: number;
  private readonly pointer: number;

  constructor(private readonly module: VadModule) {
    this.handle = module._fvad_new();
    this.pointer = module._malloc(VAD_SAMPLES * 2);
    this.reset();
  }

  reset() {
    this.module._fvad_reset(this.handle);
    this.module._fvad_set_sample_rate(this.handle, 8000);
    this.module._fvad_set_mode(this.handle, 2);
  }

  speech(pcm: ArrayBuffer, rms: number): boolean {
    const data = new DataView(pcm);
    const output = this.pointer / 2;
    let speech = false;
    for (let half = 0; half < 2; half++) {
      let input = half * VAD_SAMPLES * 6;
      for (let i = 0; i < VAD_SAMPLES; i++, input += 6) {
        this.module.HEAP16[output + i] =
          (data.getInt16(input, true) + data.getInt16(input + 2, true) + data.getInt16(input + 4, true)) / 3;
      }
      speech = this.module._fvad_process(this.handle, this.pointer, VAD_SAMPLES) === 1 || speech;
    }
    return rms > 0.0007 && speech;
  }

  close() {
    this.module._free(this.pointer);
    this.module._fvad_free(this.handle);
  }
}

let vad: Promise<VadModule> | undefined;
export async function createVoiceDetection(): Promise<VoiceDetection> {
  if (!vad) {
    const loader = chrome.runtime.getURL('audio/fvad.js');
    vad = Promise.all([
      import(/* @vite-ignore */ loader) as Promise<{ default: VadFactory }>,
      fetch(chrome.runtime.getURL('audio/fvad.wasm')).then(response => response.arrayBuffer()),
    ]).then(([{ default: factory }, wasmBinary]) => factory({ wasmBinary }))
      .catch(error => { vad = undefined; throw error; });
  }
  return new VoiceDetection(await vad);
}
