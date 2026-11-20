export const PCM_RATE = 24_000;
export const FRAME_MS = 40;
export const FRAME_SAMPLES = PCM_RATE * FRAME_MS / 1000;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

// Integrate input samples over each output sample interval. A low-pass biquad
// before decimation suppresses frequencies outside the 24 kHz signal's band.
export class PcmEncoder {
  private readonly width: number;
  private remaining: number;
  private area = 0;
  private bytes = new DataView(new ArrayBuffer(FRAME_BYTES));
  private index = 0;
  private square = 0;
  private input1 = 0;
  private input2 = 0;
  private output1 = 0;
  private output2 = 0;
  private readonly coefficients: number[] | null;

  constructor(rate: number, private readonly write: (buffer: ArrayBuffer, rms: number) => void) {
    this.width = rate / PCM_RATE;
    this.remaining = this.width;
    if (rate > PCM_RATE) {
      const angle = 2 * Math.PI * 10_000 / rate;
      const cos = Math.cos(angle);
      const divisor = 1 + Math.sin(angle) / Math.SQRT2;
      const b0 = (1 - cos) / (2 * divisor);
      this.coefficients = [b0, 2 * b0, b0, -2 * cos / divisor, (2 - divisor) / divisor];
    } else {
      this.coefficients = null;
    }
  }

  push(value: number) {
    if (this.coefficients) {
      const [b0, b1, b2, a1, a2] = this.coefficients;
      const filtered = b0 * value + b1 * this.input1 + b2 * this.input2 - a1 * this.output1 - a2 * this.output2;
      this.input2 = this.input1;
      this.input1 = value;
      this.output2 = this.output1;
      this.output1 = filtered;
      value = filtered;
    }
    let available = 1;
    while (available + 1e-9 >= this.remaining) {
      this.area += value * this.remaining;
      this.add(this.area / this.width);
      available = Math.max(0, available - this.remaining);
      this.area = 0;
      this.remaining = this.width;
    }
    this.area += value * available;
    this.remaining -= available;
  }

  private add(value: number) {
    const pcm = Math.max(-1, Math.min(1, value));
    this.bytes.setInt16(this.index * 2, Math.round(pcm * (pcm < 0 ? 32768 : 32767)), true);
    this.square += pcm * pcm;
    if (++this.index === FRAME_SAMPLES) {
      this.write(this.bytes.buffer as ArrayBuffer, Math.sqrt(this.square / FRAME_SAMPLES));
      this.bytes = new DataView(new ArrayBuffer(FRAME_BYTES));
      this.index = 0;
      this.square = 0;
    }
  }
}
