import type { Settings, Speech } from '../shared/config';
import { issueFrom, ServiceError } from '../shared/errors';
import type { Issue } from '../shared/errors';
import type { Stamp } from '../shared/protocol';
import { browserRpc, nativeRpc, probeHost } from '../local/rpc';
import type { EngineRpc } from '../local/rpc';
import type { Frame, TurnSink } from '../offscreen/turns';

export interface Result { text: string; language: string; backend: string }
export interface Translation { text: string; backend: string }
interface Identity { segmentId: string; revision: number; kind: 'partial' | 'final' }

function pcm16(frames: ArrayBuffer[]) {
  const length = frames.reduce((sum, frame) => sum + Math.floor(frame.byteLength / 6) * 2, 0);
  const pcm = new Int16Array(length);
  let index = 0;
  for (const frame of frames) {
    const data = new DataView(frame);
    for (let at = 0; at + 6 <= data.byteLength; at += 6) {
      const a = data.getInt16(at, true), b = data.getInt16(at + 2, true), c = data.getInt16(at + 4, true);
      pcm[index++] = (a * 2 + b) / 3;
      pcm[index++] = (b + c * 2) / 3;
    }
  }
  return pcm;
}

export class LocalEngine {
  private readonly rpc: EngineRpc;
  private job = 0;
  backend = '';
  translationIssue?: Issue;

  constructor(private readonly settings: Settings, private readonly session: string) {
    this.rpc = settings.runMode === 'native' ? nativeRpc() : browserRpc(chrome.runtime.getURL(''));
  }

  async connect(signal: AbortSignal) {
    if (this.settings.runMode === 'native') await probeHost(this.rpc);
    if (this.settings.runMode === 'browser' && this.settings.browserModel === 'browser-english' && this.settings.source !== 'en') {
      throw new ServiceError('language', 'Moonshine Tiny 支持英语。请固定英语源语言，或选择多语言 Whisper。');
    }
    const { backend } = await this.rpc.call<{ backend: string }>('start', {
      session: this.session, model: this.settings.runMode === 'native' ? this.settings.nativeModel : this.settings.browserModel,
      backend: this.settings.backend, base: chrome.runtime.getURL(''),
    }, { signal, timeout: 60_000 });
    this.backend = backend;
    try {
      await this.rpc.call('warm', { session: this.session, model: this.settings.translator }, { signal, timeout: 60_000 });
    } catch (error) {
      if (signal.aborted) throw error;
      this.translationIssue = issueFrom(error, 'model_load');
    }
  }

  async transcribe(frames: ArrayBuffer[], source: string, hint: string, signal: AbortSignal, identity?: Identity): Promise<Result> {
    const pcm = pcm16(frames);
    const args: Record<string, unknown> = { session: this.session, source, hint, job: ++this.job, identity };
    const transfer: Transferable[] = [];
    if (this.settings.runMode === 'browser') {
      const audio = Float32Array.from(pcm, n => n / 32768);
      Object.assign(args, { model: this.settings.browserModel, audio });
      transfer.push(audio.buffer);
    } else {
      const bytes = new Uint8Array(pcm.buffer);
      for (let at = 0, seq = 0; at < bytes.length; at += 12_000, seq++) {
        signal.throwIfAborted();
        const chunk = bytes.subarray(at, at + 12_000);
        this.rpc.notify('audio', {
          session: this.session, job: this.job, seq, format: 'pcm_s16le_16000_mono',
          data: btoa(String.fromCharCode(...chunk)),
        });
      }
    }
    const result = await this.rpc.call<Result & { identity?: Identity }>('asr', args, { signal, transfer, timeout: 30_000 });
    if (this.settings.runMode === 'native' && identity &&
      (result.identity?.segmentId !== identity.segmentId || result.identity.revision !== identity.revision || result.identity.kind !== identity.kind)) {
      throw new ServiceError('protocol');
    }
    this.backend = result.backend ?? this.backend;
    return result;
  }

  translate(args: { text: string; source: string; target: Settings['target']; context: string[]; glossary: string },
    signal: AbortSignal, identity?: Identity): Promise<Translation> {
    return this.rpc.call<Translation & { identity?: Identity }>(
      'translate', { ...args, identity, session: this.session, model: this.settings.translator }, { signal, timeout: 8000 },
    ).then(result => {
      if (this.settings.runMode === 'native' && identity &&
        (result.identity?.segmentId !== identity.segmentId || result.identity.revision !== identity.revision)) throw new ServiceError('protocol');
      return result;
    });
  }

  speak(text: string, locale: 'zh-CN' | 'zh-TW', settings: Speech, signal: AbortSignal) {
    return this.rpc.call<void>('speak', {
      session: this.session, text: text.slice(0, 290), locale,
      voice: settings.voice.startsWith('system:') ? settings.voice.slice(7) : '',
      rate: settings.rate, volume: settings.volume,
    }, { timeout: 18_000, signal });
  }

  playback(running: boolean) {
    if (this.settings.runMode === 'native') this.rpc.notify(running ? 'continue' : 'pause', { session: this.session });
  }

  close() {
    this.rpc.notify('stop', { session: this.session });
    this.rpc.close();
  }
}

interface Callbacks {
  transcript(stamp: Stamp, kind: 'partial' | 'final', result: Result): void;
  failure(issue: Issue): void;
  drop(): void;
  measured(kind: 'partial' | 'final', ms: number, behind: boolean, succeeded?: boolean): void;
}
interface Job { frames: ArrayBuffer[]; stamp: Stamp; kind: 'partial' | 'final'; overlap: boolean }

const terms = (value: string) => Array.from(value.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu));

export function trimDecoderRepetition(text: string): string {
  const parts = terms(text);
  const words = parts.map(part => part[0].toLowerCase());
  for (let start = 0; start + 15 <= words.length; start++) {
    const maxPeriod = Math.min(20, Math.floor((words.length - start) / 3));
    for (let period = 5; period <= maxPeriod; period++) {
      const phrase = words.slice(start, start + period);
      if (new Set(phrase).size < 3) continue;
      const rest = words.slice(start + period);
      if (rest.every((word, index) => word === phrase[index % period])) {
        return text.slice(0, parts[start + period].index).trim();
      }
    }
  }
  return text;
}

function omitOverlap(text: string, previous: string): string {
  const old = terms(previous), next = terms(text);
  for (let count = Math.min(9, old.length, next.length); count >= 2; count--) {
    const prefix = next.slice(0, count);
    if (prefix.reduce((n, part) => n + part[0].length, 0) < 4) continue;
    if (prefix.every((part, index) => part[0].toLowerCase() === old[old.length - count + index][0].toLowerCase())) {
      return text.slice(prefix[count - 1].index + prefix[count - 1][0].length).replace(/^[\s,.;!?，。！？、]+/u, '');
    }
  }
  return text;
}

export class LocalTranscriber implements TurnSink {
  private readonly controller = new AbortController();
  private frames: ArrayBuffer[] = [];
  private tail: ArrayBuffer[] = [];
  private overlap = false;
  private lastFinal = '';
  private previewEvery = 250;
  private running = false;
  private pending?: Job;
  private candidate = '';
  private confirmations = 0;
  private locked = '';
  private newestCommitted = 0;
  private revision = 0;
  private stalledAt = 0;

  constructor(private readonly engine: LocalEngine, private readonly source: Settings['source'], private readonly callbacks: Callbacks) {}

  begin() {
    this.frames = this.tail;
    this.overlap = this.tail.length > 0;
    this.tail = [];
  }

  append(frame: Frame, stamp: Stamp) {
    this.frames.push(frame.pcm);
    if (frame.speech && this.frames.length % this.previewEvery === 0 && !this.running && !this.pending) {
      void this.run({ frames: [...this.frames], stamp: { ...stamp }, overlap: this.overlap, kind: 'partial' });
    }
  }

  commit(stamp: Stamp) {
    this.newestCommitted = stamp.index;
    if (stamp.forced) this.tail = this.frames.slice(-6);
    const job: Job = { frames: this.frames, stamp, overlap: this.overlap, kind: 'final' };
    this.frames = [];
    if (this.running) {
      if (this.pending) this.callbacks.drop();
      this.pending = job;
    } else void this.run(job);
  }

  discard() { this.frames = []; this.tail = []; this.callbacks.drop(); }
  close() { this.controller.abort(); this.frames = []; this.tail = []; this.pending = undefined; }

  private async run(first: Job) {
    const signal = this.controller.signal;
    this.running = true;
    let job: Job | undefined = first;
    while (job && !signal.aborted) {
      if (Date.now() - job.stamp.speechEndAt > 8000) {
        this.callbacks.drop();
      } else try {
        const start = performance.now();
        const result = await this.engine.transcribe(job.frames, this.locked || this.source, job.overlap ? this.lastFinal : '', signal, {
          segmentId: String(job.stamp.index), kind: job.kind, revision: ++this.revision,
        });
        if (signal.aborted) break;
        this.stalledAt = 0;
        const elapsed = performance.now() - start;
        const slow = elapsed > (job.kind === 'partial' ? 950 : Math.max(1400, job.frames.length * 32));
        this.previewEvery = slow ? 250 : job.kind === 'final' && elapsed < 800 ? 34 : this.previewEvery;
        this.callbacks.measured(job.kind, elapsed, slow);
        result.text = trimDecoderRepetition(result.text);
        if (job.kind === 'final') {
          if (!this.locked && this.source === 'auto' && result.language && result.text.length >= 12) {
            if (result.language === this.candidate) this.confirmations++;
            else { this.candidate = result.language; this.confirmations = 1; }
            if (this.confirmations >= 2) this.locked = this.candidate;
          }
          if (job.overlap) result.text = omitOverlap(result.text, this.lastFinal);
          if (result.text) this.lastFinal = result.text.slice(-180);
        }
        if (job.kind === 'final' || job.stamp.index > this.newestCommitted) this.callbacks.transcript(job.stamp, job.kind, result);
      } catch (error) {
        const issue = issueFrom(error);
        if (!signal.aborted && issue.code !== 'cancelled') {
          if (issue.code === 'busy' || (issue.code === 'timeout' && this.engine.backend !== 'webgpu')) {
            this.previewEvery = 250;
            this.callbacks.drop();
            this.callbacks.measured(job.kind, 30_000, true, false);
            this.stalledAt ||= Date.now();
            if (issue.code === 'timeout' || Date.now() - this.stalledAt >= 16_000) {
              this.callbacks.failure(issueFrom(null, 'engine_exit'));
              break;
            }
          } else this.callbacks.failure(issue);
        }
      }
      job = this.pending;
      this.pending = undefined;
    }
    this.running = false;
  }
}

export async function localProbe(settings: Settings) {
  const engine = new LocalEngine({ ...settings, source: 'en' }, crypto.randomUUID());
  const controller = new AbortController();
  try {
    const wav = await (await fetch(chrome.runtime.getURL('audio/probe.wav'))).arrayBuffer();
    const view = new DataView(wav);
    let speech: ArrayBuffer | undefined;
    for (let at = 12; at + 8 <= wav.byteLength;) {
      const count = view.getUint32(at + 4, true);
      if (view.getUint32(at) === 0x64617461) { speech = wav.slice(at + 8, at + 8 + count); break; }
      at += 8 + count + count % 2;
    }
    if (!speech) throw new ServiceError('capture');
    await engine.connect(controller.signal);
    const start = performance.now();
    const asr = await engine.transcribe([speech], 'en', '', controller.signal);
    if (!asr.text) throw new ServiceError('inference');
    const recognized = performance.now();
    const translated = await engine.translate({
      text: asr.text, source: 'en', target: settings.target === 'en' ? 'zh-CN' : settings.target, glossary: '', context: [],
    }, controller.signal);
    return { original: asr.text, translation: translated.text, backend: asr.backend, asrMs: Math.round(recognized - start),
      translationMs: Math.round(performance.now() - recognized) };
  } finally { controller.abort(); engine.close(); }
}
