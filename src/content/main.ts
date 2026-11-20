import type { Appearance, Settings } from '../shared/config';
import type { ContentMessage, OffscreenEvent, Playback, WorkerMessage } from '../shared/protocol';
import { Overlay } from './overlay';
import { NativeCaptions } from './native-captions';
import { CaptionPiP } from './pip';

const isYouTube = /(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname);
const route = () => {
  if (!isYouTube) return location.pathname + location.search;
  const match = location.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/);
  if (match) return match[1];
  return location.pathname === '/watch' ? new URL(location.href).searchParams.get('v') ?? '' : '';
};

function area(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect();
  if (getComputedStyle(video).visibility === 'hidden' || rect.width < 80 || rect.height < 45) return 0;
  const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
  const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
  // Preserve an audio session while the currently selected player is scrolled out of view.
  return width * height || 1;
}
function players() {
  if (isYouTube && !route()) return [];
  const selectors = '#movie_player video.html5-main-video, .video-player__container video, #bilibili-player video, .bpx-player-container video';
  return Array.from(document.querySelectorAll('video')).filter(video => area(video))
    .sort((a, b) => {
      const visible = Number(area(b) > 1) - Number(area(a) > 1);
      const playing = Number(!b.paused && !b.ended) - Number(!a.paused && !a.ended);
      return visible || playing || Number(b.matches(selectors)) - Number(a.matches(selectors)) || area(b) - area(a);
    });
}
const findVideo = () => players()[0] ?? null;

class PlayerSession {
  readonly overlay: Overlay;
  private readonly listeners = new AbortController();
  private videoListeners?: AbortController;
  private readonly resize: ResizeObserver;
  private readonly timer: ReturnType<typeof setInterval>;
  private video: HTMLVideoElement | null = null;
  private navigation = route();
  private navigating = false;
  private revision = 0;
  private running?: boolean;
  private reported = 0;
  private missingSince = 0;
  private lastScan = 0;
  private readonly native = new NativeCaptions();
  private readonly pip = new CaptionPiP();
  private manual?: HTMLVideoElement;
  private sourceUrl = '';

  constructor(readonly id: string, appearance: Appearance, initialVideo: HTMLVideoElement, private captionSource: Settings['captionSource']) {
    this.overlay = new Overlay(
      id, appearance,
      (caption, at) => this.send({ target: 'worker', op: 'rendered', id, caption, at }),
      (x, y) => this.send({ target: 'worker', op: 'position', id, x, y }),
    );
    this.resize = new ResizeObserver(() => this.overlay.layout(this.video));
    this.bindVideo(initialVideo);
    this.running = this.playing();
    const option = { signal: this.listeners.signal };
    document.addEventListener('fullscreenchange', () => this.overlay.layout(this.video), option);
    window.addEventListener('resize', () => this.overlay.layout(this.video), option);
    window.addEventListener('scroll', () => this.overlay.layout(this.video), { ...option, capture: true, passive: true });
    window.addEventListener('pagehide', () => this.leave(), option);
    if (isYouTube) {
      document.addEventListener('yt-navigate-start', () => {
        this.navigating = true;
        this.sync(true);
      }, option);
      document.addEventListener('yt-navigate-finish', () => {
        this.navigating = false;
        this.scan();
      }, option);
    }
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastScan >= 450) {
        this.lastScan = now;
        this.scan();
      }
      this.overlay.draw();
      if (this.video && this.playing() && this.captionSource !== 'audio') {
        const cue = this.native.read(this.video, this.revision, this.captionSource === 'native');
        if (cue) this.send({ target: 'worker', op: 'cue', id: this.id, cue });
      }
    }, 100);
  }

  playback(): Playback {
    return {
      revision: this.revision, running: this.playing(), mediaTime: this.video?.currentTime ?? 0,
      rate: this.video?.playbackRate ?? 1, sampledAt: Date.now(),
    };
  }

  event(event: OffscreenEvent) {
    if (event.type === 'reset' && event.playbackRevision === this.revision) this.overlay.reset(event.generation);
    if (event.type === 'frame' && event.caption.playbackRevision === this.revision && this.playing()) {
      this.overlay.accept(event.caption);
    }
  }

  style(appearance: Appearance, source: Settings['captionSource']) {
    this.overlay.apply(appearance);
    if (source !== this.captionSource) this.native.reset();
    this.captionSource = source;
  }

  togglePlayer() {
    const list = players();
    if (list.length < 2) return;
    this.manual = list[(list.findIndex(item => item === this.video) + 1) % list.length];
    this.scan();
  }

  requestPiP() {
    this.overlay.askPiP(() => {
      if (!this.video) return;
      void this.pip.open(this.video, () => this.overlay.text()).then(ok => {
        if (!ok) this.send({ target: 'worker', op: 'open-subtitle-window', id: this.id });
      });
    });
  }

  end() {
    this.native.reset();
    this.pip.close();
    this.listeners.abort();
    this.videoListeners?.abort();
    this.resize.disconnect();
    clearInterval(this.timer);
    this.overlay.close();
  }

  private send(message: WorkerMessage) {
    void chrome.runtime.sendMessage(message).catch(() => {});
  }

  private leave() {
    this.overlay.clear();
    this.send({ target: 'worker', op: 'leave', id: this.id });
  }

  private playing() {
    const video = this.video;
    return !!video && !this.navigating && !video.paused && !video.ended && !video.seeking && !video.muted && video.volume > 0;
  }

  private bindVideo(video: HTMLVideoElement | null) {
    this.videoListeners?.abort();
    this.resize.disconnect();
    this.pip.close();
    this.native.reset();
    this.video = video;
    this.sourceUrl = video?.currentSrc ?? '';
    this.overlay.layout(video);
    if (!video) return;
    this.resize.observe(video);
    const signal = (this.videoListeners = new AbortController()).signal;
    for (const event of ['play', 'playing', 'pause', 'ended', 'seeked', 'ratechange', 'volumechange']) {
      video.addEventListener(event, () => this.sync(), { signal });
    }
    for (const event of ['seeking', 'emptied', 'loadstart']) {
      video.addEventListener(event, () => this.sync(true), { signal });
    }
    for (const event of ['enterpictureinpicture', 'leavepictureinpicture']) {
      video.addEventListener(event, () => this.overlay.layout(video), { signal });
    }
  }

  private scan() {
    const navigation = route();
    if (isYouTube && !navigation && !this.navigating) return this.leave();
    if (navigation !== this.navigation) this.manual = undefined;
    const video = this.manual?.isConnected ? this.manual : findVideo();
    const changed = navigation !== this.navigation || video !== this.video ||
      (video?.currentSrc && video.currentSrc !== this.sourceUrl);
    this.navigation = navigation;
    if (video !== this.video) this.bindVideo(video);
    if (video) {
      this.missingSince = 0;
      this.sourceUrl = video.currentSrc;
    } else {
      this.missingSince ||= Date.now();
      if (Date.now() - this.missingSince > 6500) return this.leave();
    }
    this.overlay.layout(video);
    if (changed || this.playing() !== this.running || Date.now() - this.reported > 2500) this.sync(!!changed);
  }

  private sync(reset = false) {
    const running = this.playing();
    if (reset || running !== this.running) {
      this.revision++;
      this.overlay.clear();
      this.native.reset();
    }
    this.running = running;
    this.reported = Date.now();
    this.send({ target: 'worker', op: 'playback', id: this.id, playback: this.playback() });
  }
}

const scope = globalThis as typeof globalThis & { horisubInstalled?: boolean };
if (!scope.horisubInstalled) {
  scope.horisubInstalled = true;
  let session: PlayerSession | undefined;
  chrome.runtime.onMessage.addListener((message: ContentMessage, sender, reply) => {
    if (message?.target !== 'content' || sender.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
    if (message.op === 'probe') {
      const video = findVideo();
      reply({ found: !!video, area: video ? area(video) : 0, viewerIssue: session?.overlay.issue });
    } else if (message.op === 'mount') {
      session?.end();
      const video = findVideo();
      session = video ? new PlayerSession(message.id, message.appearance, video, message.captionSource) : undefined;
      reply(session ? { playback: session.playback() } : null);
    } else if (session?.id === message.id) {
      if (message.op === 'remove') { session.end(); session = undefined; }
      if (message.op === 'style') session?.style(message.appearance, message.captionSource);
      if (message.op === 'pip') session?.requestPiP();
      if (message.op === 'next-player') session?.togglePlayer();
      if (message.op === 'drag') session?.overlay.tune();
      if (message.op === 'event') session?.event(message.event);
      reply(null);
    } else reply(null);
  });
}
