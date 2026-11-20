import { issueFrom } from '../shared/errors';
import type { Issue } from '../shared/errors';
import type { Caption } from '../shared/protocol';

const MAX_AGE = 10500;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Callbacks {
  translate(caption: Caption, signal: AbortSignal): Promise<string>;
  result(caption: Caption, text: string | undefined, issue?: Issue): void;
  changed(): void;
  discard(): void;
}

export class TranslationQueue {
  private waiting: Caption[] = [];
  private running = 0;
  private controller = new AbortController();
  private blocked?: Issue;

  constructor(private readonly callbacks: Callbacks) {}

  get length() { return this.running + this.waiting.length; }

  enqueue(caption: Caption) {
    if (this.blocked) {
      this.callbacks.discard();
      this.callbacks.result(caption, undefined, this.blocked);
      return;
    }
    if (this.waiting.length >= 3) this.drop(this.waiting.shift()!);
    this.waiting.push(caption);
    this.pump();
  }

  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.blocked = undefined;
    this.waiting = [];
    // In-flight jobs still count until their async handlers unwind.
    this.callbacks.changed();
  }

  private drop(caption: Caption) {
    this.callbacks.discard();
    this.callbacks.result(caption, undefined, issueFrom(null, 'busy'));
  }

  private pump() {
    while (this.running < 1 && this.waiting.length) {
      const caption = this.waiting.shift()!;
      if (Date.now() - caption.emittedAt > MAX_AGE) {
        this.drop(caption);
        continue;
      }
      if (this.blocked) {
        this.callbacks.discard();
        this.callbacks.result(caption, undefined, this.blocked);
        continue;
      }
      this.running++;
      void this.run(caption, this.controller.signal);
    }
    this.callbacks.changed();
  }

  private async run(caption: Caption, signal: AbortSignal) {
    try {
      let result: string | undefined;
      let issue: Issue | undefined;
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        try {
          result = await this.callbacks.translate(caption, signal);
          issue = undefined;
          break;
        } catch (error) {
          if (signal.aborted) return;
          issue = issueFrom(error);
          if (['model_missing','model_corrupt','model_load'].includes(issue.code)) this.blocked = issue;
          if (attempt || !issue.retry || Date.now() - caption.emittedAt >= 2000) break;
          await sleep(280 + Math.random() * 150);
        }
      }
      if (signal.aborted) return;
      if (result && Date.now() - caption.emittedAt > MAX_AGE) this.drop(caption);
      else this.callbacks.result(caption, result, issue);
    } finally {
      this.running--;
      this.pump();
    }
  }
}
