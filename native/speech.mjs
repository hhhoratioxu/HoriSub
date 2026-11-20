import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fault } from './models.mjs';

const file = name => fileURLToPath(new URL(name, import.meta.url));

export function systemSpeech(request, signal) {
  if (signal.aborted) return Promise.reject(fault('cancelled'));
  const isWindows = process.platform === 'win32';
  const executable = isWindows ? 'powershell.exe' : file('../bin/horisub-speech');
  if (!isWindows && !existsSync(executable)) return Promise.reject(fault('no_voice'));
  const args = isWindows ? ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file('./speech.ps1')] : [];
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { windowsHide: true, stdio: ['pipe','pipe','ignore'] });
    let output = '';
    const abort = () => {
      process.kill();
      reject(fault('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', data => {
      output += data;
      if (output.length > 16_000) abort();
    });
    process.once('error', () => reject(fault('no_voice')));
    process.stdin.on('error', () => {});
    process.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (code !== 0) return reject(fault('no_voice'));
      if (request.op === 'speak') return resolve(undefined);
      try { resolve(JSON.parse(output)); }
      catch { reject(fault('no_voice')); }
    });
    process.stdin.end(JSON.stringify(request) + '\n');
  });
}
