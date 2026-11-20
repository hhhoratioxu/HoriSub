import type { BrowserModel, NativeModel, RunMode, TranslationModel } from '../local/models';

export const SOURCES = {
  auto: '自动检测', en: '英语', ja: '日语', ko: '韩语', zh: '中文', es: '西班牙语',
  fr: '法语', de: '德语', pt: '葡萄牙语', ru: '俄语', ar: '阿拉伯语', it: '意大利语',
  vi: '越南语', id: '印度尼西亚语', th: '泰语', hi: '印地语',
} as const;
export const TARGETS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文（臺灣用語）', en: 'English' } as const;
export const MODES = { dual: '原文＋译文', translation: '仅译文', original: '仅原文' } as const;
export const RUN_MODES = { native: '本机引擎', browser: '浏览器本地' } as const;
export const CAPTION_SOURCES = { auto: '自动选择', native: '优先原生字幕', audio: '音频识别' } as const;
export type Source = keyof typeof SOURCES;
export type Target = keyof typeof TARGETS;
export type DisplayMode = keyof typeof MODES;

export interface Appearance {
  mode: DisplayMode; visible: boolean; size: number; color: string;
  opacity: number; outline: number; x: number; y: number; delay: number;
}
export interface Speech { enabled: boolean; voice: string; rate: number; volume: number; duck: boolean }
export interface Settings {
  source: Source;
  target: Target;
  runMode: RunMode;
  captionSource: keyof typeof CAPTION_SOURCES;
  nativeModel: NativeModel;
  browserModel: BrowserModel;
  translator: TranslationModel;
  backend: 'auto' | 'cpu';
  glossary: string;
  keepHistory: boolean;
  speech: Speech;
  appearance: Appearance;
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'dual', visible: true, size: 30, color: '#ffffff', opacity: 64, outline: 2, x: 50, y: 80, delay: 0,
};
export const DEFAULT_SETTINGS: Settings = {
  source: 'auto', target: 'zh-CN', runMode: 'native', captionSource: 'auto',
  nativeModel: 'native-base', browserModel: 'browser-tiny', translator: 'opus', backend: 'auto',
  glossary: '', keepHistory: false, speech: { enabled: false, voice: '', rate: 1, volume: 0.85, duck: false },
  appearance: DEFAULT_APPEARANCE,
};
export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function bounded(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function normalizeSettings(input: Partial<Settings> = {}): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...input };
  const a = { ...DEFAULT_APPEARANCE, ...input.appearance };
  const speech = { ...DEFAULT_SETTINGS.speech, ...input.speech };
  return {
    source: Object.hasOwn(SOURCES, settings.source) ? settings.source : 'auto',
    target: Object.hasOwn(TARGETS, settings.target) ? settings.target : 'zh-CN',
    runMode: settings.runMode === 'browser' ? 'browser' : 'native',
    captionSource: Object.hasOwn(CAPTION_SOURCES, settings.captionSource) ? settings.captionSource : 'auto',
    nativeModel: settings.nativeModel === 'native-small' || settings.nativeModel === 'native-tiny' ? settings.nativeModel : 'native-base',
    browserModel: settings.browserModel === 'browser-base' || settings.browserModel === 'browser-english' ? settings.browserModel : 'browser-tiny',
    translator: settings.translator === 'm2m' ? 'm2m' : 'opus',
    backend: settings.backend === 'cpu' ? 'cpu' : 'auto',
    glossary: typeof settings.glossary === 'string' ? settings.glossary.trim().slice(0, 600) : '',
    keepHistory: settings.keepHistory === true,
    speech: {
      enabled: speech.enabled === true, voice: typeof speech.voice === 'string' ? speech.voice.slice(0, 250) : '',
      rate: bounded(speech.rate, 1, .65, 1.45), volume: bounded(speech.volume, .85, 0, 1), duck: speech.duck === true,
    },
    appearance: {
      mode: Object.hasOwn(MODES, a.mode) ? a.mode : 'dual', visible: a.visible !== false,
      size: bounded(a.size, 30, 14, 66), color: /^#[a-f0-9]{6}$/i.test(a.color) ? a.color : '#ffffff',
      opacity: bounded(a.opacity, 64, 0, 100), outline: bounded(a.outline, 2, 0, 5),
      x: bounded(a.x, 50, 8, 92), y: bounded(a.y, 80, 12, 95), delay: bounded(a.delay, 0, 0, 5000),
    },
  };
}
