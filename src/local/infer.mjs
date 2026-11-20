import { env, pipeline } from '@huggingface/transformers';
import { Converter } from 'opencc-js';

const toSimplified = Converter({ from: 'tw', to: 'cn' });
const toTraditional = Converter({ from: 'cn', to: 'tw' });

export function configureInference({ root, cache, base }) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.useFSCache = Boolean(root);
  env.useCustomCache = Boolean(root || cache);
  if (root) env.localModelPath = root;
  if (env.useCustomCache) {
    // Native inference loads ONNX by file path from the verified model directory,
    // avoiding a copy in Node and a second cache that could shadow those files.
    env.customCache = {
      match: async key => cache ? (await cache.match(key)) ?? undefined : undefined,
      put: () => {},
    };
  }
  if (base) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.wasmPaths = base + 'runtime/';
  }
}

const LANGS = new Set(['en','ja','ko','zh','es','fr','de','pt','ru','ar','it','vi','id','th','hi']);

export class LocalInference {
  pipes = new Map();
  constructor(catalog, device) {
    this.catalog = catalog;
    this.device = device;
  }

  get(task, key) {
    const name = this.device + '/' + key;
    if (this.pipes.has(name)) return this.pipes.get(name);
    const model = this.catalog[key];
    const loading = pipeline(task, model.repo, {
      dtype: 'q8', revision: model.revision, local_files_only: true, device: this.device,
      session_options: this.device === 'cpu' ? {
        intraOpNumThreads: key === 'opus' ? 1 : 2,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
        enableMemPattern: false,
      } : undefined,
    }).catch(error => { this.pipes.delete(name); throw error; });
    this.pipes.set(name, loading);
    return loading;
  }

  async withFallback(fn) {
    try { return await fn(); }
    catch (error) {
      if (this.device !== 'webgpu') throw error;
      this.device = 'wasm';
      await Promise.allSettled([...this.pipes.values()].map(work => work.then(pipe => pipe.dispose())));
      this.pipes.clear();
      return fn();
    }
  }

  prepare(key) {
    return this.withFallback(() => this.get(key.startsWith('browser') ? 'automatic-speech-recognition' : 'translation', key))
      .then(() => ({ backend: this.device }));
  }

  recognize(job) {
    return this.withFallback(async () => {
      const asr = await this.get('automatic-speech-recognition', job.model);
      if (job.model === 'browser-english') {
        if (job.source !== 'en') throw Object.assign(new Error('English only'), { code: 'language' });
        const result = await asr(job.audio, { max_new_tokens: 90 });
        return { text: result.text.trim(), language: 'en', backend: this.device };
      }
      const { input_features } = await asr.processor(job.audio);
      let output;
      try {
        output = await asr.model.generate({
          inputs: input_features,
          ...(job.source !== 'auto' ? { language: job.source } : {}),
          task: 'transcribe', return_timestamps: false, max_new_tokens: 90, num_beams: 1,
        });
        const [sequence] = output.tolist();
        const prefix = asr.tokenizer.decode(sequence.slice(0, 4), { skip_special_tokens: false });
        const match = /<\|([a-z]{2})\|>/.exec(prefix)?.[1];
        const language = job.source !== 'auto' ? job.source : LANGS.has(match) ? match : match ?? '';
        return { text: asr.tokenizer.decode(sequence, { skip_special_tokens: true }).trim(), language, backend: this.device };
      } finally {
        input_features.dispose();
        output?.dispose();
      }
    });
  }

  translate(job) {
    return this.withFallback(async () => {
      const target = job.target === 'en' ? 'en' : 'zh';
      const source = job.source;
      if (!LANGS.has(source)) throw Object.assign(new Error('unknown language'), { code: 'language' });
      let text = job.text;
      if (source !== target) {
        if (job.model !== 'm2m' && (source !== 'en' || target !== 'zh')) {
          throw Object.assign(new Error('language pair'), { code: 'language' });
        }
        const pipe = await this.get('translation', job.model);
        const result = await pipe(text, {
          ...(job.model === 'm2m' && { src_lang: source, tgt_lang: target }),
          max_new_tokens: Math.max(24, Math.min(160, Math.ceil(text.length * 1.2) + 16)), num_beams: 1,
        });
        text = result[0]?.translation_text?.trim();
        if (!text) throw Object.assign(new Error('empty translation'), { code: 'inference' });
      }
      if (target === 'zh') text = job.target === 'zh-TW' ? toTraditional(text) : toSimplified(text);
      // The glossary is a literal source=target dictionary. Context is limited to three confirmed captions.
      const context = (job.context ?? []).slice(-3).map(line => line.slice(0, 240)).join(' ');
      for (const row of (job.glossary ?? '').slice(0, 600).split(/\r?\n/)) {
        const separator = row.indexOf('=');
        if (separator < 1) continue;
        const from = row.slice(0, separator).trim();
        const to = row.slice(separator + 1).trim();
        if (from && to && (job.text.includes(from) || context.includes(from))) {
          text = text.replaceAll(from, to);
        }
      }
      return { text, backend: this.device };
    });
  }

  async dispose() {
    await Promise.allSettled([...this.pipes.values()].map(work => work.then(pipe => pipe.dispose())));
    this.pipes.clear();
  }
}
