import { sha256 } from '@noble/hashes/sha2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ServiceError } from '../shared/errors';
import catalog from './catalog.json';

export type ModelKey = keyof typeof catalog;
export type NativeModel = Extract<ModelKey, `native-${string}`>;
export type BrowserModel = Extract<ModelKey, `browser-${string}`>;
export type TranslationModel = 'opus' | 'm2m';
export type RunMode = 'native' | 'browser';
export const MODEL_CACHE = 'horisub-models-v1';
export const MODEL_PERMISSIONS = ['https://huggingface.co/*', 'https://*.hf.co/*', 'https://*.xethub.hf.co/*'];
export { catalog };

interface Asset { path: string; size: number; sha256?: string; git?: string }
export interface ModelStatus { ready: boolean; bytes: number; path: string }
const urlFor = (key: ModelKey, file: Asset) =>
  'https://huggingface.co/' + catalog[key].repo + '/resolve/' + catalog[key].revision + '/' + file.path;

function digest(file: Asset) {
  const hash = file.sha256 ? sha256.create() : sha1.create();
  if (file.git) hash.update(new TextEncoder().encode('blob ' + file.size + '\0'));
  return hash;
}

async function valid(response: Response | undefined, file: Asset, verify: boolean) {
  if (!response || response.headers.get('x-horisub-digest') !== (file.sha256 ?? file.git)) return false;
  if (!verify) return true;
  const hash = digest(file);
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > file.size) return false;
      hash.update(value);
    }
    return size === file.size && bytesToHex(hash.digest()) === (file.sha256 ?? file.git);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function browserStatus(key: ModelKey, verify = false): Promise<ModelStatus> {
  const cache = await caches.open(MODEL_CACHE);
  let bytes = 0;
  for (const file of catalog[key].files) {
    if (await valid(await cache.match(urlFor(key, file)), file, verify)) bytes += file.size;
  }
  return { ready: bytes === catalog[key].bytes, bytes, path: 'Chrome 扩展缓存 · ' + MODEL_CACHE };
}

export async function browserDownload(key: ModelKey, signal: AbortSignal, progress: (bytes: number, total: number) => void) {
  const cache = await caches.open(MODEL_CACHE);
  const { quota, usage } = await navigator.storage.estimate().catch(() => ({ quota: undefined, usage: undefined }));
  const { bytes: existing } = await browserStatus(key);
  const total = catalog[key].bytes;
  if (quota !== undefined && usage !== undefined && quota - usage < total - existing) throw new ServiceError('disk');
  let completed = 0;
  let lastNotice = 0;
  for (const file of catalog[key].files) {
    const url = urlFor(key, file);
    signal.throwIfAborted();
    if (!await valid(await cache.match(url), file, true)) {
      try {
        const origin = await fetch(url + '?download=true&hori=' + Date.now(), { signal, credentials: 'omit', cache: 'no-store' });
        if (!origin.ok || !origin.body || new URL(origin.url).protocol !== 'https:') throw new ServiceError('download');
        const hash = digest(file);
        let size = 0;
        const expected = file.sha256 ?? file.git ?? '';
        const verified = origin.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(data, out) {
            size += data.byteLength;
            if (size > file.size) throw new ServiceError('model_corrupt');
            hash.update(data);
            if (Date.now() - lastNotice > 260) {
              progress(completed + size, total);
              lastNotice = Date.now();
            }
            out.enqueue(data);
          },
          flush() {
            if (size !== file.size || bytesToHex(hash.digest()) !== expected) throw new ServiceError('model_corrupt');
          },
        }), { signal });
        await cache.put(url, new Response(verified, {
          headers: { 'x-horisub-digest': expected, 'Content-Length': String(file.size) },
        }));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new ServiceError('disk');
        if (signal.aborted) throw new ServiceError('cancelled');
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('download');
      }
    }
    completed += file.size;
    progress(completed, total);
  }
  return browserStatus(key);
}

export async function browserRemove(key: ModelKey) {
  const cache = await caches.open(MODEL_CACHE);
  for (const file of catalog[key].files) await cache.delete(urlFor(key, file));
  return browserStatus(key);
}
