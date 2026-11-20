import type { Settings } from '../shared/config';
import { issueFrom, ServiceError } from '../shared/errors';
import type { Issue } from '../shared/errors';
import type { Caption, LiveState, NativeCue, OffscreenEvent, Phase, Playback, SessionRef, Stamp } from '../shared/protocol';
import { LocalEngine, LocalTranscriber } from '../providers/asr';
import type { Result } from '../providers/asr';
import { TabAudio } from './capture';
import { Metrics } from './metrics';
import { SpeechQueue } from './speech';
import { TranslationQueue } from './translation-queue';
import { SpeechTurns } from './turns';
import { createVoiceDetection } from './vad';
import type { VoiceDetection } from './vad';

export class CaptureSession {
  private readonly capture = new TabAudio();
  private readonly metrics = new Metrics();
  private readonly captions = new Map<number, Caption>();
  private readonly translations: TranslationQueue;
  private readonly speech: SpeechQueue;
  private vad?: VoiceDetection;
  private engine?: LocalEngine;
  private engineAbort?: AbortController;
  private preparing = false;
  private provider?: LocalTranscriber;
  private turns?: SpeechTurns;
  private timer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private audioFrames = 0;
  private signalPeak = 0;
  private lastSpeech = 0;
  private lastFrame = 0;
  private lastSequence = 0;
  private lastNative = 0;
  private nativeIndex = 0;
  private generation = 0;
  private phase: Phase = 'starting';
  private issue?: Issue;
  private translationIssue?: Issue;
  private speechIssue?: Issue;
  private speedIssue?: Issue;
  private closed = false;
  private ready = false;

  constructor(
    readonly ref: SessionRef, private settings: Settings, private playback: Playback,
    private readonly publish: (event: OffscreenEvent) => void, private readonly onEnded: (issue: Issue) => void,
  ) {
    this.speech = new SpeechQueue(ref.id, settings, value => this.capture.duck(value), issue => { this.speechIssue = issue; }, () => this.engine);
    this.translations = new TranslationQueue({
      translate: async (caption, signal) => {
        const context = [...this.captions.values()]
          .filter(other => other.index < caption.index && other.kind === 'final' && other.language === caption.language)
          .sort((a, b) => a.index - b.index).slice(-3).map(other => other.original);
        const result = await this.engine!.translate({
          text: caption.original, source: caption.language, target: this.settings.target,
          glossary: this.settings.glossary, context,
        }, signal, { segmentId: caption.id, revision: caption.version, kind: 'final' });
        return result.text;
      },
      result: (caption, text, issue) => this.translated(caption, text, issue),
      changed: () => { this.metrics.queueMax = Math.max(this.metrics.queueMax, this.translations.length); },
      discard: () => { this.metrics.discarded++; },
    });
  }

  async start(streamId: string) {
    try {
      await Promise.all([
        createVoiceDetection().then(detector => { if (this.closed) detector.close(); else this.vad = detector; }),
        this.capture.start(streamId, (frame, at) => this.frame(frame.pcm, frame.rms, frame.sequence, at),
          () => this.onEnded(issueFrom(null, 'capture'))),
      ]);
      if (this.closed) return;
      this.ready = true;
      this.timer = setInterval(() => this.tick(), 600);
      void this.connect();
    } catch (error) {
      if (!this.closed) {
        const detail = error instanceof Error ? error.name + ' ' + error.message.slice(0, 150) : 'UnknownError';
        this.onEnded(issueFrom(error instanceof ServiceError ? error :
          new ServiceError('capture', '音频处理初始化失败（' + detail + '）。')));
      }
    }
  }

  snapshot(): LiveState {
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return {
      session: this.ref, phase: this.phase, issue: this.issue, translationIssue: this.translationIssue,
      speechIssue: this.speechIssue, speedIssue: this.speedIssue,
      translating: this.translations.length > 0, generation: this.generation, playbackRevision: this.playback.revision,
      runMode: this.settings.runMode, backend: this.engine?.backend ?? '', actualSource: this.lastNative ? 'native' : 'audio',
      diagnostics: { ...this.metrics.snapshot(this.translations.length), heap, audioFrames: this.audioFrames, signalPeak: this.signalPeak, spoken: this.speech.completed },
    };
  }

  updatePlayback(playback: Playback) {
    if (playback.revision < this.playback.revision || playback.sampledAt < this.playback.sampledAt) return;
    const reset = playback.revision !== this.playback.revision || playback.running !== this.playback.running;
    this.playback = playback;
    if (reset) {
      this.lastNative = 0;
      this.invalidate();
      this.engine?.playback(playback.running);
      this.resume();
    }
  }

  updateSettings(settings: Settings) {
    const reset = settings.source !== this.settings.source || settings.target !== this.settings.target ||
      settings.captionSource !== this.settings.captionSource;
    this.settings = {
      ...this.settings, source: settings.source, target: settings.target, captionSource: settings.captionSource,
      speech: settings.speech, glossary: settings.glossary,
    };
    this.speech.update(this.settings);
    if (reset) {
      this.lastNative = 0;
      this.invalidate();
      this.resume();
    }
  }

  nativeCue(cue: NativeCue | null) {
    if (!cue || !this.engine?.backend || this.settings.captionSource === 'audio' ||
      cue.revision !== this.playback.revision || !this.playback.running) return;
    if (!this.lastNative) this.invalidate();
    this.lastNative = Date.now();
    this.setPhase('listening');
    const language = this.settings.source === 'auto' ? cue.language : this.settings.source;
    this.transcript({ index: ++this.nativeIndex, startedAt: this.lastNative, speechEndAt: this.lastNative, committedAt: this.lastNative },
      'final', { text: cue.text, language, backend: this.engine.backend }, cue);
  }

  rendered(caption: Caption, at: number) {
    if (caption.generation !== this.generation || caption.playbackRevision !== this.playback.revision) return;
    const current = this.captions.get(caption.index);
    if (current?.id !== caption.id || current.version !== caption.version) return;
    this.metrics.record('render', at - caption.emittedAt);
    if (caption.translationState === 'done') {
      this.metrics.delivered++;
      this.metrics.record('total', at - current.speechEndAt);
    }
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    this.invalidate(false);
    this.engineAbort?.abort();
    this.engine?.close();
    this.engine = undefined;
    this.vad?.close();
    this.vad = undefined;
    await this.capture.close();
  }

  private setPhase(phase: Phase, issue?: Issue) {
    if (this.closed || (phase === this.phase && issue?.code === this.issue?.code)) return;
    this.phase = phase;
    this.issue = issue;
    this.publish({ type: 'phase', phase, issue });
  }

  private frame(pcm: ArrayBuffer, rms: number, sequence: number, at: number) {
    this.audioFrames++;
    this.signalPeak = Math.max(this.signalPeak, Math.round(rms * 10000) / 10000);
    if (this.closed || !this.playback.running || !this.turns || !this.vad || Date.now() - at > 450) return;
    const elapsed = at - this.lastFrame;
    const gap = this.lastSequence && (sequence !== this.lastSequence + 1 || elapsed > 800);
    this.lastFrame = at;
    if (gap) {
      this.metrics.discarded++;
      if (elapsed > 4000) {
        this.invalidate();
        this.resume();
        return;
      }
      this.turns.reset();
      this.provider?.discard();
      this.vad.reset();
    }
    this.lastSequence = sequence;
    const speech = this.vad.speech(pcm, rms);
    if (speech) { this.lastSpeech = at; this.setPhase('listening'); }
    this.turns.feed({ pcm, speech, at });
  }

  private tick() {
    const now = Date.now();
    if (this.lastNative && now - this.lastNative > 5400) {
      this.lastNative = 0;
      this.invalidate();
      this.resume();
    }
    if (this.turns && now - this.lastSpeech > 1500 && !this.turns.active) this.setPhase('silent');
  }

  private resume() {
    if (!this.ready || this.closed || this.preparing) return;
    if (!this.engine?.backend) return;
    if (!this.playback.running) { this.setPhase('paused'); return; }
    if (this.lastNative) return;
    const engine = this.engine;
    const generation = this.generation;
    const current = () => !this.closed && generation === this.generation;
    const provider = this.provider = new LocalTranscriber(engine, this.settings.source, {
      transcript: (stamp, kind, result) => { if (current()) this.transcript(stamp, kind, result); },
      failure: issue => { if (current()) this.failed(issue); },
      drop: () => { if (current()) this.metrics.discarded++; },
      measured: (kind, elapsed, slow, succeeded = true) => {
        if (!current()) return;
        if (kind === 'final' && succeeded) this.metrics.record('inference', elapsed);
        if (slow || kind === 'final') this.speedIssue = slow ? issueFrom(null, 'slow') : undefined;
      },
    });
    this.turns = new SpeechTurns({
      begin: () => provider.begin(), append: (frame, stamp) => provider.append(frame, stamp),
      discard: () => provider.discard(),
      commit: stamp => {
        this.metrics.turns++;
        this.metrics.record('capture', stamp.committedAt - stamp.startedAt);
        provider.commit(stamp);
      },
    });
    this.lastSpeech = Date.now();
    this.setPhase('listening');
  }

  private invalidate(emit = true) {
    this.generation++;
    this.provider?.close();
    this.provider = undefined;
    this.turns = undefined;
    this.vad?.reset();
    this.lastSequence = 0;
    this.nativeIndex = 0;
    this.captions.clear();
    this.translations.reset();
    this.speech.clear();
    if (emit) this.publish({ type: 'reset', generation: this.generation, playbackRevision: this.playback.revision });
  }

  private async connect() {
    if (this.preparing || this.closed) return;
    this.preparing = true;
    this.engineAbort = new AbortController();
    this.setPhase(this.attempts ? 'retrying' : 'loading', this.attempts ? this.issue : undefined);
    try {
      const engine = this.engine = new LocalEngine(this.settings, this.ref.id);
      await engine.connect(this.engineAbort.signal);
      this.translationIssue = engine.translationIssue;
      this.preparing = false;
      this.resume();
    } catch (error) {
      this.preparing = false;
      if (!this.closed) this.failed(issueFrom(error, 'model_load'));
    }
  }

  private failed(issue: Issue) {
    if (this.closed) return;
    this.lastNative = 0;
    this.invalidate();
    const backend = this.engine?.backend;
    this.engine?.close();
    this.engine = undefined;
    if (backend === 'webgpu' && this.settings.backend === 'auto' && issue.code === 'timeout') {
      this.settings = { ...this.settings, backend: 'cpu' };
      this.speedIssue = issueFrom(null, 'slow');
    }
    if (!issue.retry) {
      this.setPhase('error', issue);
      this.onEnded(issue);
      return;
    }
    if (this.attempts >= 3) {
      this.setPhase('error', issue);
      this.onEnded(issue);
      return;
    }
    this.setPhase('retrying', issue);
    this.retryTimer = setTimeout(() => { void this.connect(); }, 750 * 2 ** this.attempts++);
  }

  private transcript(stamp: Stamp, kind: Caption['kind'], result: Result, cue?: NativeCue) {
    const previous = this.captions.get(stamp.index);
    if (previous?.kind === 'final' || (kind === 'partial' && !result.text)) return;
    const now = Date.now();
    if (kind === 'final') this.metrics.record('asr', now - stamp.committedAt);
    if (now - stamp.speechEndAt > 18_000) { this.metrics.discarded++; return; }
    const media = (at: number) => Number.isFinite(this.playback.mediaTime) ? Math.max(0,
      this.playback.mediaTime + (at - this.playback.sampledAt) * this.playback.rate / 1000) : null;
    const caption: Caption = {
      ...stamp, sessionId: this.ref.id, generation: this.generation, playbackRevision: this.playback.revision,
      id: this.generation + ':' + stamp.index, version: (previous?.version ?? 0) + 1,
      kind, original: result.text, emittedAt: now, translationState: result.text ? 'pending' : 'failed',
      language: result.language, source: cue ? 'native' : 'audio',
      mediaTime: cue?.mediaStart ?? media(stamp.startedAt), mediaEndTime: cue?.mediaEnd ?? media(stamp.speechEndAt),
    };
    this.captions.set(stamp.index, caption);
    if (this.captions.size > 24) this.captions.delete(Math.min(...this.captions.keys()));
    this.publish({ type: 'frame', caption });
    if (kind === 'final' && result.text) this.translations.enqueue(caption);
  }

  private translated(caption: Caption, text: string | undefined, issue?: Issue) {
    const current = this.captions.get(caption.index);
    if (current?.id !== caption.id || current.version !== caption.version) { this.metrics.discarded++; return; }
    const at = Date.now();
    if (text) this.metrics.record('translation', at - caption.emittedAt);
    this.translationIssue = issue;
    const updated: Caption = { ...caption, emittedAt: at, translation: text, translationState: text ? 'done' : 'failed' };
    this.captions.set(caption.index, updated);
    this.publish({ type: 'frame', caption: updated });
    this.speech.enqueue(updated);
  }
}
