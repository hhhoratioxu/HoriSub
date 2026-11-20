import type { NativeCue } from '../shared/protocol';

const pageSelectors = [
  '#movie_player .ytp-caption-segment', '.player-captions-container [data-a-target="player-caption"]',
  '.bpx-player-subtitle-panel-text', '.bilibili-player-video-subtitle span',
].join(',');
const clean = (text: string) => text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 900);

function clue(text: string): string {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'ru';
  if (/\p{Script=Arabic}/u.test(text)) return 'ar';
  const site = document.documentElement.lang.split('-')[0].toLowerCase();
  return /[a-z]/i.test(text) && (!site || ['zh','ja','ko','ru','ar'].includes(site)) ? 'en' : site;
}

export class NativeCaptions {
  private track?: TextTrack;
  private restore?: TextTrackMode;
  private seen = '';
  private candidate = '';
  private since = 0;
  private style?: HTMLStyleElement;

  read(video: HTMLVideoElement, revision: number, prefer: boolean): NativeCue | null {
    if (!this.track || this.track.mode === 'disabled') {
      this.releaseTrack();
      const tracks = Array.from(video.textTracks).filter(track => ['subtitles','captions'].includes(track.kind));
      this.track = tracks.find(track => track.mode === 'showing') ??
        tracks.find(track => track.mode === 'hidden') ?? (prefer ? tracks[0] : undefined);
      if (this.track) {
        this.restore = this.track.mode;
        if (this.track.mode === 'disabled') this.track.mode = 'hidden';
      }
    }
    const list = Array.from(this.track?.activeCues ?? []).filter((c): c is VTTCue => 'text' in c);
    if (list.length) {
      const text = clean(list.map(cue => cue.text).join(' '));
      const id = list.map(cue => cue.startTime + '/' + cue.endTime).join(',') + '/' + text;
      if (!text || id === this.seen) return null;
      this.seen = id;
      if (this.track!.mode === 'showing') this.track!.mode = 'hidden';
      return { text, language: this.track?.language?.split('-')[0] || clue(text),
        mediaStart: list[0].startTime, mediaEnd: list[list.length - 1].endTime, revision };
    }

    const raw = clean(Array.from(document.querySelectorAll(pageSelectors), node => node.textContent ?? '').join(' '));
    if (!raw) {
      this.candidate = '';
      return null;
    }
    const now = Date.now();
    if (this.candidate !== raw) {
      this.candidate = raw;
      this.since = now;
      return null;
    }
    if (now - this.since < 390 || raw === this.seen) return null;
    const prior = this.seen;
    this.seen = raw;
    this.style ??= document.createElement('style');
    if (!this.style.isConnected) {
      this.style.textContent = pageSelectors + ' { visibility: hidden !important; }';
      document.documentElement.append(this.style);
    }
    let shared = 0;
    for (let length = Math.min(prior.length, raw.length); length >= 5; length--) {
      if (prior.endsWith(raw.slice(0, length))) { shared = length; break; }
    }
    const text = raw.slice(shared).trim();
    if (!text) return null;
    return { text, language: clue(text), mediaStart: video.currentTime, mediaEnd: video.currentTime + 1.2, revision };
  }

  releaseTrack() {
    if (this.track && this.restore && this.track.mode === 'hidden') this.track.mode = this.restore;
    this.track = undefined;
    this.restore = undefined;
  }

  reset() {
    this.releaseTrack();
    this.style?.remove();
    this.seen = '';
    this.candidate = '';
  }
}
