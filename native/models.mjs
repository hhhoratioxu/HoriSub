import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm, rename, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import catalog from '../src/local/catalog.json' with { type: 'json' };

export { catalog };
export const modelsRoot = process.env.HORISUB_MODEL_DIR || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'HoriSub', 'models')
  : join(homedir(), 'Library', 'Caches', 'HoriSub', 'models'));
export const fault = code => Object.assign(new Error(code), { code });

function model(key) {
  if (typeof key !== 'string' || !Object.hasOwn(catalog, key) || key.startsWith('browser')) throw fault('protocol');
  return catalog[key];
}

function hashFor(file) {
  const hash = createHash(file.sha256 ? 'sha256' : 'sha1');
  if (file.git) hash.update('blob ' + file.size + '\0');
  return hash;
}

async function valid(path, file, verify = false) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== file.size) return false;
  if (!verify) return true;
  const hash = hashFor(file);
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex') === (file.sha256 ?? file.git);
}

const local = (pack, file) => join(modelsRoot, pack.repo, file.path);
export function whisperPath(key) {
  const pack = model(key);
  if (!key.startsWith('native')) throw fault('protocol');
  return local(pack, pack.files[0]);
}

export async function status(key, verify = false) {
  const pack = model(key);
  const results = await Promise.all(pack.files.map(file => valid(local(pack, file), file, verify)));
  return { ready: results.every(Boolean), bytes: results.reduce((n, result, i) => n + (result ? pack.files[i].size : 0), 0), path: modelsRoot };
}

async function withLock(key, run) {
  await mkdir(modelsRoot, { recursive: true });
  const lock = join(modelsRoot, '.' + key + '.lock');
  let handle;
  try { handle = await open(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = await stat(lock).then(value => Date.now() - value.mtimeMs, () => 0);
    if (age < 60 * 60_000) throw fault('busy');
    await rm(lock, { force: true });
    handle = await open(lock, 'wx');
  }
  try { return await run(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

export async function download(key, signal, progress) {
  const pack = model(key);
  return withLock(key, async () => {
    const disk = await statfs(modelsRoot).catch(() => null);
    const existing = await status(key, true);
    if (disk && disk.bavail * disk.bsize < Math.max(0, pack.bytes - existing.bytes) + 16 * 1024 * 1024) throw fault('disk');
    let done = 0;
    let lastNotice = 0;
    for (const file of pack.files) {
      signal.throwIfAborted();
      const path = local(pack, file);
      if (!await valid(path, file, true)) {
        const source = 'https://huggingface.co/' + pack.repo + '/resolve/' + pack.revision + '/' + file.path +
          '?download=true&hori=' + Date.now();
        const temp = path + '.part-' + process.pid;
        await mkdir(dirname(path), { recursive: true });
        try {
          const response = await fetch(source, { signal, cache: 'no-store' });
          if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw fault('download');
          const hash = hashFor(file);
          let bytes = 0;
          const meter = new Transform({
            transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > file.size) return callback(fault('model_corrupt'));
              hash.update(chunk);
              if (Date.now() - lastNotice > 260) {
                progress(done + bytes, pack.bytes);
                lastNotice = Date.now();
              }
              callback(null, chunk);
            },
          });
          await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { flags: 'wx' }), { signal });
          if (bytes !== file.size || hash.digest('hex') !== (file.sha256 ?? file.git)) throw fault('model_corrupt');
          await rename(temp, path);
        } finally { await rm(temp, { force: true }); }
      }
      done += file.size;
      progress(done, pack.bytes);
    }
    return status(key);
  });
}

export async function remove(key) {
  const pack = model(key);
  return withLock(key, async () => {
    for (const file of pack.files) await rm(local(pack, file), { force: true });
    return status(key);
  });
}
