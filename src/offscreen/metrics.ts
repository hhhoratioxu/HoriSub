import type { Diagnostics, Timing } from '../shared/protocol';

export class Metrics {
  readonly samples = new Map<Timing, number[]>();
  queueMax = 0;
  discarded = 0;
  turns = 0;
  delivered = 0;

  record(key: Timing, value: number) {
    if (value < 0 || !Number.isFinite(value)) return;
    const series = this.samples.get(key) ?? [];
    if (series.length >= 180) series.shift();
    series.push(value);
    this.samples.set(key, series);
  }

  snapshot(queue: number): Diagnostics {
    const timings: Diagnostics['timings'] = {};
    for (const [key, values] of this.samples) {
      const sorted = [...values].sort((a, b) => a - b);
      timings[key] = {
        count: sorted.length,
        p50: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
        p95: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
      };
    }
    return { timings, queue, queueMax: this.queueMax, turns: this.turns, discarded: this.discarded, delivered: this.delivered };
  }
}
