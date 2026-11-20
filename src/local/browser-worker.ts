import { LocalInference, configureInference } from './infer.mjs';
import { MODEL_CACHE, browserStatus, catalog } from './models';
import type { BrowserModel, TranslationModel } from './models';

interface Args {
  base: string; backend: string; model: BrowserModel | TranslationModel; audio: Float32Array;
  source: string; target: string; text: string; glossary: string; context: string[]; id: number;
}
let engine: LocalInference | undefined;
let queue = Promise.resolve();
const cancelled = new Set<number>();
const readAsset = self.fetch.bind(self);
self.fetch = (resource, init) => {
  const url = new URL(resource instanceof Request ? resource.url : String(resource), self.location.href);
  const packaged = url.protocol === self.location.protocol && url.host === self.location.host;
  if (!packaged && url.protocol !== 'data:' && url.protocol !== 'blob:') {
    return Promise.reject(new Error('Inference assets must be local.'));
  }
  return readAsset(resource, init);
};

self.onmessage = ({ data }: MessageEvent<{ id: number; op: string; args: Args }>) => {
  const { op, id, args } = data;
  if (op === 'cancel') {
    cancelled.add(args.id);
    if (cancelled.size > 24) cancelled.delete(cancelled.values().next().value!);
    return;
  }
  queue = queue.then(async () => {
    if (cancelled.delete(id)) return;
    try {
      let value: unknown;
      if (op === 'start') {
        if (!(await browserStatus(args.model)).ready) throw { code: 'model_missing' };
        const cache = await caches.open(MODEL_CACHE);
        configureInference({ base: args.base, cache });
        const api = (navigator as Navigator & { gpu?: { requestAdapter(options?: object): Promise<{ info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null> } }).gpu;
        const adapter = args.backend !== 'cpu' && await api?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
        const gpu = adapter && !(adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter ||
          /swiftshader|software/i.test((adapter.info?.vendor ?? '') + (adapter.info?.architecture ?? '')));
        engine = new LocalInference(catalog, gpu ? 'webgpu' : 'wasm');
        value = await engine.prepare(args.model);
      } else if (!engine) throw { code: 'model_load' };
      else if (op === 'asr') value = await engine.recognize({ ...args, audio: args.audio });
      else if (op === 'warm') {
        if (!(await browserStatus(args.model)).ready) throw { code: 'model_missing' };
        value = await engine.prepare(args.model);
      } else if (op === 'translate') {
        if (args.source !== (args.target === 'en' ? 'en' : 'zh') && !(await browserStatus(args.model)).ready) throw { code: 'model_missing' };
        value = await engine.translate(args);
      } else if (op === 'stop') { await engine.dispose(); engine = undefined; }
      if (!cancelled.delete(id)) self.postMessage({ id, value });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!cancelled.delete(id)) self.postMessage({ id, code: code ?? 'model_load' });
    }
  });
};
