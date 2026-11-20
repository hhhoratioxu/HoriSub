import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fault, whisperPath } from './models.mjs';

export const exe = fileURLToPath(new URL('../bin/horisub-whisper' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));

const metalExe = fileURLToPath(new URL('../bin/horisub-whisper-metal', import.meta.url));

export class WhisperProcess {
  child;
  requests = new Map();
  sequence = 0;
  backend;

  async open(model, backend) {
    const metal = backend !== 'cpu' && process.platform === 'darwin' && existsSync(metalExe);
    await new Promise((resolve, reject) => {
      const child = this.child = spawn(metal ? metalExe : exe, [whisperPath(model), metal ? 'auto' : 'cpu'], { stdio: ['pipe', 'pipe', process.env.HORISUB_ENGINE_DEBUG ? 'inherit' : 'ignore'], windowsHide: true });
      const timer = setTimeout(() => { this.close(); reject(fault('model_load')); }, metal ? 9600 : 30_000);
      const exited = () => {
        clearTimeout(timer);
        reject(fault('model_load'));
        if (this.child === child) this.child = undefined;
        for (const waiter of this.requests.values()) waiter.reject(fault('engine_exit'));
        this.requests.clear();
      };
      child.once('error', exited);
      child.once('exit', exited);
      child.stdin.on('error', exited);
      createInterface({ input: child.stdout }).on('line', line => {
        if (line.length > 9000) return this.close();
        let answer;
        try { answer = JSON.parse(line); } catch { return this.close(); }
        if (answer.ready) {
          clearTimeout(timer);
          this.backend = answer.backend;
          return resolve();
        }
        if (!answer.id && answer.issue) {
          clearTimeout(timer);
          return reject(fault(answer.issue));
        }
        const pending = this.requests.get(answer.id);
        if (!pending) return;
        this.requests.delete(answer.id);
        if (answer.issue) pending.reject(fault(answer.issue));
        else pending.resolve({ ...answer, text: answer.text.trim(), backend: this.backend });
      });
    });
    return { backend: this.backend };
  }

  transcribe(pcm, source, context, signal) {
    const child = this.child;
    if (!child) return Promise.reject(fault('engine_exit'));
    if (this.requests.size) return Promise.reject(fault('busy'));
    signal.throwIfAborted();
    const id = ++this.sequence;
    const prompt = Buffer.from(context || '').subarray(0, 700);
    const head = Buffer.alloc(13);
    head.writeUInt32LE(9 + prompt.length + pcm.length);
    head[4] = 1;
    head.writeUInt32LE(id, 5);
    if (source !== 'auto') head.write(source, 9, 2, 'ascii');
    head.writeUInt16LE(prompt.length, 11);
    let watchdog;
    const cancel = () => {
      const msg = Buffer.alloc(9);
      msg.writeUInt32LE(5);
      msg[4] = 2;
      msg.writeUInt32LE(id, 5);
      child.stdin.write(msg);
      watchdog = setTimeout(() => {
        if (this.child !== child || !this.requests.has(id)) return;
        // Leave the native transport responsive even if the backend cannot interrupt a kernel.
        this.child = undefined;
        child.kill('SIGKILL');
        this.requests.get(id)?.reject(fault('engine_exit'));
        this.requests.delete(id);
      }, 1800);
    };
    signal.addEventListener('abort', cancel, { once: true });
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      child.stdin.write(Buffer.concat([head, prompt, pcm]));
    }).finally(() => {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', cancel);
    });
  }

  close() {
    this.child?.kill();
    this.child = undefined;
    for (const waiter of this.requests.values()) waiter.reject(fault('cancelled'));
    this.requests.clear();
  }
}
