import type { Speech } from '../shared/config';
import { ServiceError } from '../shared/errors';

const name = (voice: chrome.tts.TtsVoice) => JSON.stringify([voice.voiceName, voice.lang, voice.extensionId]);
async function localVoices() {
  const all = await chrome.tts.getVoices();
  return all.filter(voice => voice.remote === false && /^zh(?:-|_|$)/i.test(voice.lang ?? '') && voice.voiceName &&
    !all.some(other => other.remote !== false && name(other) === name(voice)));
}
export async function voices() {
  return (await localVoices()).map(voice => ({ id: name(voice), name: voice.voiceName, locale: voice.lang }));
}

let revision = 0;
let release: (() => void) | undefined;

export function stopSpeech() {
  revision++;
  if (!release) return;
  release();
  release = undefined;
  void chrome.tts.stop();
}

export async function speak(text: string, settings: Speech, locale: 'zh-CN' | 'zh-TW') {
  const expected = revision;
  const available = await localVoices();
  if (expected !== revision || !settings.enabled) return;
  const voice = settings.voice ? available.find(item => name(item) === settings.voice) :
    available.find(item => item.lang?.replace('_', '-') === locale) ?? available[0];
  if (!voice) throw new ServiceError('no_voice');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: ServiceError) => {
      clearTimeout(timer);
      if (release === abort) release = undefined;
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    const timer = setTimeout(() => { finish(); void chrome.tts.stop(); }, 12_000);
    release = abort;
    void chrome.tts.speak(text.slice(0, 290), {
      voiceName: voice.voiceName, extensionId: voice.extensionId, lang: voice.lang, enqueue: false,
      rate: settings.rate, volume: settings.volume, onEvent: event => {
        if (event.type === 'error') finish(new ServiceError('no_voice'));
        if (['end','cancelled','interrupted'].includes(event.type)) finish();
      },
    }).catch(() => finish(new ServiceError('no_voice')));
  });
}
