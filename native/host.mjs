import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import app from '../package.json' with { type: 'json' };
import { download, fault, modelsRoot, remove, status } from './models.mjs';
import { exe, WhisperProcess } from './whisper.mjs';
import { systemSpeech } from './speech.mjs';

const MAX_PACKET = 92_000;
const SESSION_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const languagePattern = /^(auto|[a-z]{2})$/;

function hello() {
  if (!existsSync(exe)) throw fault('host_version');
  return {
    protocol: 1, version: app.version, platform: process.platform + '-' + process.arch,
    engine: 'whisper.cpp 1.9.5', translation: 'ONNX Runtime CPU', path: modelsRoot,
  };
}

class Runtime {
  session;
  language;
  languageJobs = new Map();
  recognition;
  audio = new Map();
  jobs = new Map();

  send(value) {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > 100_000) return;
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    process.stdout.write(Buffer.concat([size, data]));
  }

  async handle(message) {
    if (!Number.isSafeInteger(message?.id) || message.id <= 0 || typeof message.op !== 'string') return;
    const { id, op, args = {} } = message;
    if (op === 'audio') {
      try { this.storeAudio(args); }
      catch { this.audio.delete(args.job); }
      return;
    }
    if (op === 'cancel') {
      this.audio.delete(args.job);
      this.jobs.get(args.id)?.abort();
      return;
    }
    if (op === 'exit') { this.close(); return; }
    if (this.jobs.size >= 6) return this.send({ id, code: 'busy' });
    const controller = new AbortController();
    this.jobs.set(id, controller);
    try {
      const value = await this.perform(id, op, args, controller.signal);
      if (!controller.signal.aborted) this.send({ id, value });
    } catch (error) {
      const codes = ['host_version','model_missing','model_corrupt','model_load','busy','protocol',
        'language','inference','engine_exit','cancelled','download','disk','no_voice'];
      const code = codes.includes(error.code) ? error.code : error.code === 'ENOSPC' ? 'disk' :
        controller.signal.aborted ? 'cancelled' : op === 'download' ? 'download' : 'inference';
      this.send({ id, code });
    } finally { this.jobs.delete(id); }
  }

  async perform(id, op, args, signal) {
    if (op === 'hello') return hello();
    if (op === 'voices') return systemSpeech({ op: 'voices' }, signal);
    if (op === 'status') return status(args.model, args.verify === true);
    if (op === 'download') return download(args.model, signal, (bytes, total) => this.send({ id, event: 'progress', bytes, total }));
    if (op === 'remove') return remove(args.model);
    if (op === 'start' && typeof args.session === 'string' && SESSION_ID.test(args.session) && !this.session &&
        typeof args.model === 'string' && args.model.startsWith('native')) {
      this.session = args.session;
      if (!(await status(args.model)).ready) throw fault('model_missing');
      if (!(await status(args.model, true)).ready) throw fault('model_corrupt');
      signal.throwIfAborted();
      this.recognition = new WhisperProcess();
      const backend = args.backend === 'cpu' ? 'cpu' : 'auto';
      try { return await this.recognition.open(args.model, backend); }
      catch (error) {
        if (backend === 'cpu' || process.platform !== 'darwin') throw error;
        signal.throwIfAborted();
        this.recognition.close();
        this.recognition = new WhisperProcess();
        return this.recognition.open(args.model, 'cpu');
      }
    }
    if (args.session !== this.session || !this.session) throw fault('protocol');
    if (op === 'pause' || op === 'continue') { this.audio.clear(); return {}; }
    if (op === 'stop') { this.stop(); return {}; }
    if (op === 'speak') {
      if (typeof args.text !== 'string' || args.text.length > 300 || !['zh-CN','zh-TW'].includes(args.locale)) throw fault('protocol');
      return systemSpeech({
        op: 'speak', text: args.text, locale: args.locale,
        voice: typeof args.voice === 'string' ? args.voice.slice(0, 228) : '',
        rate: Number.isFinite(args.rate) ? Math.max(.65, Math.min(1.45, args.rate)) : 1,
        volume: Number.isFinite(args.volume) ? Math.max(0, Math.min(1, args.volume)) : .85,
      }, signal);
    }
    if (op === 'warm') {
      if (!['opus', 'm2m'].includes(args.model)) throw fault('protocol');
      if (!(await status(args.model)).ready) throw fault('model_missing');
      return this.translate(id, { model: args.model }, 'warm');
    }
    const identity = args.identity;
    if (identity !== undefined && (!identity || typeof identity.segmentId !== 'string' || identity.segmentId.length > 128 ||
        !Number.isSafeInteger(identity.revision) || !['partial','final'].includes(identity.kind))) throw fault('protocol');
    const decorate = value => ({ ...value, session: args.session, identity });
    if (op === 'translate') {
      if (!['opus', 'm2m'].includes(args.model) || typeof args.text !== 'string' || args.text.length > 2000 ||
          typeof args.source !== 'string' || !languagePattern.test(args.source) || !['zh-CN','zh-TW','en'].includes(args.target)) throw fault('protocol');
      if (args.source !== (args.target === 'en' ? 'en' : 'zh') && !(await status(args.model)).ready) throw fault('model_missing');
      signal.throwIfAborted();
      return this.translate(id, {
        model: args.model, text: args.text, source: args.source, target: args.target,
        glossary: typeof args.glossary === 'string' ? args.glossary.slice(0, 600) : '',
        context: Array.isArray(args.context) ? args.context.filter(value => typeof value === 'string').slice(-3).map(val => val.slice(0, 240)) : [],
      }).then(decorate);
    }
    if (op === 'asr') {
      if (typeof args.source !== 'string' || !languagePattern.test(args.source)) throw fault('protocol');
      const job = this.audio.get(args.job);
      this.audio.delete(args.job);
      if (!job || job.length < 4000 || !this.recognition) throw fault('protocol');
      return this.recognition.transcribe(Buffer.concat(job.chunks), args.source,
        typeof args.hint === 'string' ? args.hint.slice(-180) : '', signal).then(decorate);
    }
    throw fault('protocol');
  }

  storeAudio(args) {
    if (!this.session || args.session !== this.session || !Number.isSafeInteger(args.job) || args.format !== 'pcm_s16le_16000_mono' ||
        typeof args.data !== 'string' || args.data.length > 24_000) throw fault('protocol');
    let job = this.audio.get(args.job);
    if (!job && args.seq === 0 && this.audio.size < 2) {
      job = { next: 0, length: 0, chunks: [] };
      this.audio.set(args.job, job);
    }
    const bytes = Buffer.from(args.data, 'base64');
    if (!job || args.seq !== job.next || bytes.length % 2 || bytes.length > 16_000 || job.length + bytes.length > 230_000) throw fault('protocol');
    job.next++;
    job.length += bytes.length;
    job.chunks.push(bytes);
  }

  translate(id, args, op = 'translate') {
    if (!this.language) {
      const worker = this.language = new Worker(new URL('./language.mjs', import.meta.url), {
        workerData: { root: modelsRoot }, stdout: true, stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on('message', ({ id, value, code }) => {
        const pending = this.languageJobs.get(id);
        if (!pending) return;
        this.languageJobs.delete(id);
        if (code) pending.reject(fault(code));
        else pending.resolve(value);
      });
      worker.on('error', () => {});
      worker.on('exit', () => {
        if (this.language !== worker) return;
        this.language = undefined;
        for (const pending of this.languageJobs.values()) pending.reject(fault('engine_exit'));
        this.languageJobs.clear();
      });
    }
    if (this.languageJobs.size >= 2) throw fault('busy');
    return new Promise((resolve, reject) => {
      this.languageJobs.set(id, { resolve, reject });
      this.language.postMessage({ id, args, op });
    });
  }

  stop() {
    this.session = undefined;
    this.recognition?.close();
    this.recognition = undefined;
    void this.language?.terminate();
    this.language = undefined;
    for (const pending of this.languageJobs.values()) pending.reject(fault('cancelled'));
    this.languageJobs.clear();
    this.audio.clear();
  }

  close() {
    for (const job of this.jobs.values()) job.abort();
    this.stop();
  }
}

if (process.argv.includes('--self-check')) {
  try {
    const info = hello();
    const { LocalInference } = await import('../src/local/infer.mjs');
    if (!LocalInference) throw fault('model_load');
    console.log('HoriSub ' + info.version + ' / ' + info.platform + ' / ' + info.engine);
  } catch {
    console.error('HoriSub runtime is incomplete. Reinstall this engine package.');
    process.exitCode = 1;
  }
} else {
  let pending = Buffer.alloc(0);
  const runtime = new Runtime();
  process.stdin.on('data', data => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (!size || size > MAX_PACKET) { runtime.close(); process.exit(2); }
      if (pending.length < size + 4) break;
      const payload = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      try { void runtime.handle(JSON.parse(payload.toString('utf8'))); }
      catch { /* Malformed payloads never reach model execution. */ }
    }
  });
  process.stdin.on('end', () => runtime.close());
  process.stdout.on('error', () => { runtime.close(); process.exit(0); });
}
