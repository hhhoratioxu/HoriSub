import type { Settings } from '../shared/config';
import { issueFrom } from '../shared/errors';
import type { Issue } from '../shared/errors';
import type { LocalEngine } from '../providers/asr';
import type { Caption, Reply } from '../shared/protocol';

export class SpeechQueue {
  private pending?: Caption;
  private running = false;
  private generation = 0;
  private speaking?: AbortController;
  private spoken = -1;
  completed = 0;

  constructor(private readonly id: string, private settings: Settings,
    private readonly setDucked: (value: boolean) => void, private readonly issue: (value?: Issue) => void,
    private readonly getEngine: () => LocalEngine | undefined) {}

  update(settings: Settings) {
    if (settings.target !== this.settings.target || JSON.stringify(settings.speech) !== JSON.stringify(this.settings.speech)) this.clear();
    this.settings = settings;
  }

  enqueue(caption: Caption) {
    if (!this.settings.speech.enabled || this.settings.target === 'en' || !caption.translation || caption.index <= this.spoken) return;
    this.pending = caption;
    void this.drain();
  }

  clear() {
    this.generation++;
    this.speaking?.abort();
    this.pending = undefined;
    this.spoken = -1;
    this.setDucked(false);
    this.issue();
    void chrome.runtime.sendMessage({ target: 'worker', op: 'stop-speech', id: this.id }).catch(() => {});
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.pending) {
      const next = this.pending;
      this.pending = undefined;
      const { speech, target } = this.settings;
      if (!speech.enabled || target === 'en' || Date.now() - next.speechEndAt > 8000) continue;
      this.spoken = next.index;
      const generation = this.generation;
      const controller = this.speaking = new AbortController();
      this.setDucked(speech.duck);
      try {
        const engine = this.getEngine();
        if (this.settings.runMode === 'native' && engine && (!speech.voice || speech.voice.startsWith('system:'))) {
          try {
            await engine.speak(next.translation!, target, speech, controller.signal);
            if (generation === this.generation) { this.completed++; this.issue(); }
            continue;
          } catch (error) {
            if (controller.signal.aborted) continue;
            if (speech.voice.startsWith('system:')) throw error;
          }
        }
        const response = await chrome.runtime.sendMessage<unknown, Reply<void>>({
          target: 'worker', op: 'speak', id: this.id, text: next.translation, speech, language: target,
        });
        if (generation === this.generation) {
          if (response?.ok) this.completed++;
          this.issue(response?.ok ? undefined : response?.issue);
        }
      } catch {
        if (generation === this.generation) this.issue(issueFrom(null, 'no_voice'));
      } finally {
        if (this.speaking === controller) this.speaking = undefined;
        this.setDucked(false);
      }
    }
    this.running = false;
  }
}
