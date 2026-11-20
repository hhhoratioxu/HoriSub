import { clamp } from '../shared/config';
import type { Appearance } from '../shared/config';
import type { Caption } from '../shared/protocol';

const CSS = `
:host { all: initial; display: block; pointer-events: none; }
.anchor {
  position: absolute; left: var(--x); top: var(--y); width: var(--width);
  max-width: 1100px; transform: translate(-50%, -100%); text-align: center;
  color: var(--ink); font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
  unicode-bidi: isolate; line-height: 1.28; font-weight: 620;
}
.row { display: flex; justify-content: center; margin-top: 4px; }
.row[hidden], button[hidden] { display: none; }
.row span {
  max-width: 100%; box-sizing: border-box; padding: .17em .43em;
  background: rgb(0 0 0 / var(--alpha)); border-radius: .21em;
  overflow-wrap: anywhere; text-shadow: 0 1px var(--outline) #000, 0 0 var(--outline) #000;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
.source { font-size: var(--primary); }
.dual .source { font-size: var(--secondary); }
.translation { font-size: var(--primary); }
button {
  pointer-events: auto; touch-action: none; cursor: grab; user-select: none; margin: 0 auto 6px;
  padding: 7px 12px; border: 1px solid #68dec7; border-radius: 999px; color: #bdf7eb;
  background: #101d23; font: 600 12px system-ui; letter-spacing: .03em;
}
button:active { cursor: grabbing; }
`;

interface Entry { caption: Caption; received: number; changed: number; finalized?: number; translated?: number }

export class Overlay {
  private readonly host = document.createElement('div');
  private readonly anchor = document.createElement('div');
  private readonly sourceRow = document.createElement('div');
  private readonly sourceText = document.createElement('span');
  private readonly translationRow = document.createElement('div');
  private readonly translationText = document.createElement('span');
  private readonly handle = document.createElement('button');
  private readonly pip = document.createElement('button');
  private readonly entries = new Map<number, Entry>();
  private generation = -1;
  private floor = 0;
  private current?: number;
  private shownAt = 0;
  private visibleKey = '';
  private metricsKey = '';
  private drag = false;
  private stuck?: { id: number; x: number; y: number };
  private viewerIssue?: string;
  private available = false;

  constructor(private readonly id: string, private appearance: Appearance,
    private readonly report: (caption: Caption, at: number) => void,
    private readonly moved: (x: number, y: number) => void,
  ) {
    this.host.dataset.horisub = 'overlay';
    Object.assign(this.host.style, {
      pointerEvents: 'none', zIndex: '2147483646', margin: '0', padding: '0', border: '0', contain: 'layout style',
    });
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.anchor.className = 'anchor';
    this.sourceRow.className = 'row source';
    this.translationRow.className = 'row translation';
    this.sourceText.dir = this.translationText.dir = 'auto';
    this.sourceRow.append(this.sourceText);
    this.translationRow.append(this.translationText);
    this.handle.type = 'button';
    this.handle.textContent = '拖动字幕位置';
    this.handle.hidden = true;
    this.handle.addEventListener('pointerdown', event => {
      this.handle.setPointerCapture(event.pointerId);
      this.stuck = { id: event.pointerId, x: this.appearance.x, y: this.appearance.y };
    });
    this.handle.addEventListener('pointermove', event => {
      if (this.stuck?.id !== event.pointerId) return;
      const rect = this.host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Math.round(clamp((event.clientX - rect.left) / rect.width * 100, 8, 92));
      const y = Math.round(clamp((event.clientY - rect.top) / rect.height * 100, 12, 95));
      this.stuck = { id: event.pointerId, x, y };
      this.apply({ ...this.appearance, x, y });
    });
    this.handle.addEventListener('lostpointercapture', () => {
      if (!this.stuck) return;
      this.moved(this.stuck.x, this.stuck.y);
      this.stuck = undefined;
      this.drag = false;
      this.draw();
    });
    this.pip.type = 'button';
    this.pip.textContent = '打开字幕画中画';
    this.pip.hidden = true;
    this.anchor.append(this.pip, this.handle, this.sourceRow, this.translationRow);
    shadow.append(style, this.anchor);
    this.apply(appearance);
    this.paint();
  }

  text() { return { original: this.sourceText.textContent ?? '', translation: this.translationText.textContent ?? '' }; }

  askPiP(open: () => void) {
    this.pip.hidden = false;
    this.pip.onclick = () => { this.pip.hidden = true; open(); };
  }

  get issue() { return this.viewerIssue; }

  layout(video: HTMLVideoElement | null) {
    const fullscreen = document.fullscreenElement;
    const youtube = video?.closest('#movie_player');
    this.available = false;
    if (!video) this.viewerIssue = undefined;
    else if (document.pictureInPictureElement === video) {
      this.viewerIssue = 'Chrome 原生画中画只显示视频画面，字幕层留在网页。';
    } else if (fullscreen instanceof HTMLVideoElement) {
      this.viewerIssue = '此播放器使用视频元素原生全屏。请退出全屏查看网页字幕。';
    } else if (fullscreen && !fullscreen.contains(video)) {
      this.viewerIssue = '当前全屏元素不包含视频播放器。';
    } else {
      const container = fullscreen || youtube || document.body;
      if (this.host.parentElement !== container) container.append(this.host);
      const rect = video.getBoundingClientRect();
      if (fullscreen || youtube) {
        Object.assign(this.host.style, { position: 'absolute', inset: '0', width: 'auto', height: 'auto' });
      } else {
        Object.assign(this.host.style, {
          position: 'fixed', inset: 'auto', left: rect.left + 'px', top: rect.top + 'px',
          width: rect.width + 'px', height: rect.height + 'px',
        });
      }
      const scale = clamp((fullscreen || youtube ? container.clientWidth : rect.width) / 750, 0.63, 1);
      this.host.style.setProperty('--primary', Math.max(13, Math.round(this.appearance.size * scale)) + 'px');
      this.host.style.setProperty('--secondary', Math.max(12, Math.round(this.appearance.size * scale * 0.78)) + 'px');
      this.available = rect.width > 0 && rect.height > 0;
      this.viewerIssue = undefined;
    }
    this.host.style.display = this.available ? 'block' : 'none';
  }

  apply(appearance: Appearance) {
    this.appearance = appearance;
    this.anchor.classList.toggle('dual', appearance.mode === 'dual');
    this.host.style.setProperty('--x', appearance.x + '%');
    this.host.style.setProperty('--y', appearance.y + '%');
    this.host.style.setProperty('--width', Math.min(86, 2 * Math.min(appearance.x, 100 - appearance.x) - 3) + '%');
    this.host.style.setProperty('--alpha', String(appearance.opacity / 100));
    this.host.style.setProperty('--ink', appearance.color);
    this.host.style.setProperty('--outline', appearance.outline + 'px');
    this.draw();
  }

  tune() {
    this.drag = !this.drag;
    this.draw();
  }

  clear() {
    this.entries.clear();
    this.floor = 0;
    this.current = undefined;
    this.paint();
  }

  reset(generation: number) {
    if (generation <= this.generation) return;
    this.generation = generation;
    this.clear();
  }

  accept(caption: Caption) {
    if (caption.sessionId !== this.id || caption.generation < this.generation) return;
    this.reset(caption.generation);
    if (caption.index < this.floor || Date.now() - caption.speechEndAt > 20_000) return;
    const previous = this.entries.get(caption.index);
    if (previous && (previous.caption.version > caption.version ||
        (previous.caption.version === caption.version && previous.caption.translationState !== 'pending'))) return;
    if (!caption.original) {
      this.entries.delete(caption.index);
      if (this.current === caption.index) this.current = undefined;
      this.draw();
      return;
    }
    const now = Date.now();
    this.entries.set(caption.index, {
      caption, received: previous?.received ?? now, changed: now,
      finalized: caption.kind === 'final' ? previous?.finalized ?? now : undefined,
      translated: caption.translationState === 'done' ? previous?.translated ?? now : undefined,
    });
    if (this.entries.size > 8) this.entries.delete(Math.min(...this.entries.keys()));
    this.draw();
  }

  draw() {
    const now = Date.now();
    for (const [index, entry] of this.entries) {
      const dwell = clamp(entry.caption.original.length * 21 + 2400, 2800, 6500);
      if (now - entry.changed > dwell + this.appearance.delay) this.entries.delete(index);
    }
    let current = this.current === undefined ? undefined : this.entries.get(this.current);
    const eligible = [...this.entries.values()].filter(entry =>
      now >= entry.received + this.appearance.delay && entry.caption.index >= this.floor &&
      (this.appearance.mode !== 'translation' || entry.caption.translationState !== 'pending'));
    const next = eligible.sort((a, b) => b.caption.index - a.caption.index)[0];
    if (next && (!current || (next.caption.index > current.caption.index && now >= this.until(current)))) {
      current = next;
      this.current = this.floor = current.caption.index;
      this.shownAt = now;
      for (const index of this.entries.keys()) if (index < this.floor) this.entries.delete(index);
    }
    this.paint(current?.caption);
  }

  close() { this.host.remove(); }

  private until(entry: Entry): number {
    if (entry.caption.kind === 'partial') return Math.min(this.shownAt + 6700, entry.changed + 1350);
    if (this.appearance.mode === 'original') return this.shownAt + 1100;
    if (entry.translated) return Math.max(this.shownAt, entry.translated) + 1300;
    return Math.max(this.shownAt, entry.finalized ?? 0) + (entry.caption.translationState === 'pending' ? 2300 : 1050);
  }

  private paint(caption?: Caption) {
    this.handle.hidden = !this.drag;
    let source = '';
    let result = '';
    if (caption && this.appearance.visible) {
      const { mode } = this.appearance;
      if (mode !== 'translation' || caption.translationState === 'failed') source = caption.original;
      if (mode !== 'original') result = caption.translation ?? '';
    }
    this.sourceRow.hidden = !source;
    this.translationRow.hidden = !result;
    if (this.sourceText.textContent !== source) this.sourceText.textContent = source;
    if (this.translationText.textContent !== result) this.translationText.textContent = result;
    this.visibleKey = caption && (source || result) && this.available
      ? caption.id + '/' + caption.version + '/' + !!result : '';
    if (!caption || caption.kind !== 'final' || !this.visibleKey || this.metricsKey === this.visibleKey) return;
    const key = this.visibleKey;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.visibleKey !== key || !this.host.isConnected || this.metricsKey === key) return;
      this.metricsKey = key;
      this.report(result ? caption : { ...caption, translationState: 'pending' }, Date.now());
    }));
  }
}
