import type { Appearance, Settings, Speech } from './config';
import type { Issue } from './errors';

export type Phase = 'starting' | 'loading' | 'listening' | 'silent' | 'paused' | 'retrying' | 'error';
export interface Playback { revision: number; running: boolean; mediaTime: number; rate: number; sampledAt: number }
export interface SessionRef { id: string; tabId: number; origin: string; frameId: number; startedAt: number; title: string }
export interface Stamp { index: number; startedAt: number; speechEndAt: number; committedAt: number; forced?: boolean }
export interface NativeCue { text: string; language: string; mediaStart: number; mediaEnd: number; revision: number }

export interface Caption extends Stamp {
  sessionId: string; generation: number; playbackRevision: number;
  id: string; version: number; kind: 'partial' | 'final'; original: string;
  translation?: string; translationState: 'pending' | 'done' | 'failed';
  emittedAt: number; mediaTime: number | null; mediaEndTime: number | null;
  language: string; source: 'native' | 'audio';
}
export type Timing = 'capture' | 'inference' | 'asr' | 'translation' | 'render' | 'total';
export interface Distribution { count: number; p50: number; p95: number }
export interface Diagnostics {
  timings: Partial<Record<Timing, Distribution>>;
  queue: number; queueMax: number; discarded: number; turns: number; delivered: number; heap?: number; audioFrames?: number; signalPeak?: number; spoken?: number;
}
export interface LiveState {
  session: SessionRef; phase: Phase; issue?: Issue; translationIssue?: Issue; speechIssue?: Issue; speedIssue?: Issue;
  translating: boolean; generation: number; playbackRevision: number; diagnostics: Diagnostics;
  runMode: Settings['runMode']; backend: string; actualSource: 'audio' | 'native';
}

export type OffscreenEvent =
  | { type: 'frame'; caption: Caption }
  | { type: 'reset'; generation: number; playbackRevision: number }
  | { type: 'phase'; phase: Phase; issue?: Issue }
  | { type: 'ended'; issue?: Issue };

export type WorkerMessage = { target: 'worker' } & (
  | { op: 'settings' }
  | { op: 'save'; settings: Settings }
  | { op: 'quick'; source: Settings['source']; targetLanguage: Settings['target']; mode: Appearance['mode']; visible: boolean; speech: boolean }
  | { op: 'status'; tabId?: number }
  | { op: 'start' | 'stop' | 'drag' | 'pip' | 'next-player'; tabId: number }
  | { op: 'test' }
  | { op: 'history' | 'clear-history' | 'voices' | 'caption-window' }
  | { op: 'speak'; id: string; text: string; speech: Speech; language: 'zh-CN' | 'zh-TW' }
  | { op: 'stop-speech'; id: string }
  | { op: 'event'; session: SessionRef; event: OffscreenEvent }
  | { op: 'cue'; id: string; cue: NativeCue | null }
  | { op: 'playback'; id: string; playback: Playback }
  | { op: 'leave'; id: string }
  | { op: 'open-subtitle-window'; id: string }
  | { op: 'position'; id: string; x: number; y: number }
  | { op: 'rendered'; id: string; caption: Caption; at: number }
);
export type EngineMessage = { target: 'engine' } & (
  | { op: 'status' }
  | { op: 'start'; session: SessionRef; streamId: string; settings: Settings; playback: Playback }
  | { op: 'stop'; id: string }
  | { op: 'update'; id: string; settings: Settings }
  | { op: 'playback'; id: string; playback: Playback }
  | { op: 'cue'; id: string; cue: NativeCue | null }
  | { op: 'rendered'; id: string; caption: Caption; at: number }
  | { op: 'test'; settings: Settings }
);
export type ContentMessage = { target: 'content' } & (
  | { op: 'probe' }
  | { op: 'mount'; id: string; appearance: Appearance; captionSource: Settings['captionSource'] }
  | { op: 'remove' | 'drag' | 'pip' | 'next-player'; id: string }
  | { op: 'style'; id: string; appearance: Appearance; captionSource: Settings['captionSource'] }
  | { op: 'event'; id: string; event: OffscreenEvent }
);
export interface PopupState { settings: Settings; live: LiveState | null; issue?: Issue; viewerIssue?: string }
export type Reply<T> = { ok: true; value: T } | { ok: false; issue: Issue };
