import type { Stamp } from '../shared/protocol';
import { FRAME_MS } from './pcm';

export interface Frame { pcm: ArrayBuffer; at: number; speech: boolean }
export interface TurnSink {
  begin(stamp: Stamp): void;
  append(frame: Frame, stamp: Stamp): void;
  commit(stamp: Stamp): void;
  discard(): void;
}

export class SpeechTurns {
  private index = 0;
  private preRoll: Frame[] = [];
  private stamp: Stamp | null = null;
  private consecutiveSpeech = 0;
  private voicedFrames = 0;
  private frames = 0;

  constructor(private readonly sink: TurnSink, private readonly maxMs = 4400) {}

  get active() { return this.stamp !== null; }

  feed(frame: Frame) {
    if (!this.stamp) {
      this.preRoll.push(frame);
      if (this.preRoll.length > 6) this.preRoll.shift();
      this.consecutiveSpeech = frame.speech ? this.consecutiveSpeech + 1 : 0;
      if (this.consecutiveSpeech < 2) return;
      this.stamp = {
        index: ++this.index, startedAt: this.preRoll[0].at - FRAME_MS,
        speechEndAt: frame.at, committedAt: 0,
      };
      this.sink.begin(this.stamp);
      for (const buffered of this.preRoll) this.append(buffered);
      this.preRoll = [];
      return;
    }
    this.append(frame);
    if (!this.stamp) return;
    if (frame.at - this.stamp.speechEndAt >= 360 || this.frames * FRAME_MS >= this.maxMs) {
      const stamp = { ...this.stamp, committedAt: frame.at, forced: this.frames * FRAME_MS >= this.maxMs };
      const hasSpeech = this.voicedFrames >= 4;
      this.reset();
      if (hasSpeech) this.sink.commit(stamp);
      else this.sink.discard();
    }
  }

  reset() {
    this.preRoll = [];
    this.stamp = null;
    this.consecutiveSpeech = 0;
    this.voicedFrames = 0;
    this.frames = 0;
  }

  private append(frame: Frame) {
    if (!this.stamp) return;
    if (frame.speech) {
      this.voicedFrames++;
      this.stamp.speechEndAt = frame.at;
    }
    this.frames++;
    this.sink.append(frame, this.stamp);
  }
}
