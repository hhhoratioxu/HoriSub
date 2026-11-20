import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const target = process.argv[2];
if (!['darwin-arm64','win-x64'].includes(target)) throw Error('Specify darwin-arm64 or win-x64.');
const windows = target === 'win-x64';
const archiveDir = process.env.HORISUB_NODE_ARCHIVES;
if (!archiveDir) throw Error('Set HORISUB_NODE_ARCHIVES to a directory with the pinned Node binaries and SHASUMS256.txt.');
const whisperSource = process.env.HORISUB_WHISPER_SOURCE;
if (!whisperSource) throw Error('Set HORISUB_WHISPER_SOURCE to the pinned whisper.cpp source directory.');
const nodeVersion = '24.22.3';
const nodeName = 'node-v' + nodeVersion + '-' + target;
const nodeFile = nodeName + (windows ? '.zip' : '.tar.gz');
const archive = join(archiveDir, nodeFile);
const sums = await readFile(join(archiveDir, 'SHASUMS256.txt'), 'utf8');
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
if (!sums.split('\n').some(line => line.trim().split(/\s+/).join(' ') === hash + ' ' + nodeFile)) throw Error('Node archive checksum differs.');
const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + Number.parseInt(character, 16)));

const temp = await mkdtemp(join(tmpdir(), 'horisub-release-'));
try {
  const title = 'HoriSub-Engine-' + manifest.version + '-' + target;
  const bundle = join(temp, title), engine = join(bundle, 'engine'), runtime = join(engine, 'runtime');
  const destination = resolve('release', title + '.zip');
  const run = (exe, args, cwd = process.cwd()) => {
    const result = spawnSync(exe, args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) throw Error(exe + ' failed: ' + result.error);
  };
  await mkdir(join(engine, 'bin'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(join(engine, 'native'), { recursive: true });
  await mkdir(join(engine, 'src/local'), { recursive: true });
  await mkdir('release', { recursive: true });
  if (windows) run('unzip', ['-q', archive], temp);
  else run('tar', ['-xzf', archive], temp);
  const binary = windows ? 'node.exe' : 'node';
  await copyFile(join(temp, nodeName, windows ? binary : 'bin/' + binary), join(runtime, binary));
  await copyFile(join(temp, nodeName, 'LICENSE'), join(runtime, 'NODE-LICENSE.txt'));
  if (!windows) await chmod(join(runtime, binary), 0o755);
  for (const file of ['models.mjs','whisper.mjs','language.mjs','host.mjs','speech.mjs']) await copyFile('native/' + file, join(engine, 'native', file));
  for (const file of ['infer.mjs','catalog.json']) await copyFile('src/local/' + file, join(engine, 'src/local', file));
  await copyFile('bin/horisub-whisper' + (windows ? '.exe' : ''), join(engine, 'bin', 'horisub-whisper' + (windows ? '.exe' : '')));
  if (windows) {
    await copyFile('bin/horisub-engine.exe', join(engine, 'horisub-engine.exe'));
    await copyFile('native/speech.ps1', join(engine, 'native', 'speech.ps1'));
  }
  else {
    await copyFile('native/install/run.sh', join(engine, 'run.sh'));
    if (existsSync('bin/horisub-speech')) {
      await copyFile('bin/horisub-speech', join(engine, 'bin', 'horisub-speech'));
      await chmod(join(engine, 'bin', 'horisub-speech'), 0o755);
    }
    if (existsSync('bin/horisub-whisper-metal')) {
      await copyFile('bin/horisub-whisper-metal', join(engine, 'bin', 'horisub-whisper-metal'));
      await chmod(join(engine, 'bin', 'horisub-whisper-metal'), 0o755);
    }
  }
  for (const name of ['Install','Repair','Uninstall']) {
    const file = name + (windows ? '.cmd' : '.command');
    await copyFile('native/install/' + file, join(bundle, file));
    if (!windows) await chmod(join(bundle, file), 0o755);
  }
  await copyFile('native/install/installer.mjs', join(bundle, 'installer.mjs'));
  await copyFile(join(whisperSource, 'LICENSE'), join(runtime, 'WHISPER-CPP-LICENSE.txt'));
  await writeFile(join(bundle, 'registration.json'), JSON.stringify({ extensionId }, null, 2) + '\n');
  await copyFile('native/install/QUICKSTART.md', join(bundle, 'INSTALL.md'));
  for (const document of ['THIRD_PARTY.md']) {
    if (existsSync(document)) await copyFile(document, join(bundle, document));
  }
  await cp('package.json', join(engine, 'package.json'));
  await cp('package-lock.json', join(engine, 'package-lock.json'));
  run('npm', ['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--os=' + (windows ? 'win32' : 'darwin'), '--cpu=' + (windows ? 'x64' : 'arm64')], engine);
  const ort = join(engine, 'node_modules/onnxruntime-node/bin/napi-v3');
  for (const platform of await readdir(ort)) {
    const keep = windows ? 'win32' : 'darwin';
    if (platform !== keep) await rm(join(ort, platform), { recursive: true, force: true });
    else for (const architecture of await readdir(join(ort, platform))) {
      if (architecture !== (windows ? 'x64' : 'arm64')) await rm(join(ort, platform, architecture), { recursive: true, force: true });
    }
  }
  if (!windows) {
    await chmod(join(engine, 'run.sh'), 0o755);
    await chmod(join(engine, 'bin', 'horisub-whisper'), 0o755);
    run(join(runtime, 'node'), [join(engine, 'native', 'host.mjs'), '--self-check']);
  }
  const temporaryZip = join(temp, title + '.zip');
  run('zip', ['-q','-1','-r',temporaryZip,title], temp);
  await copyFile(temporaryZip, destination + '.partial');
  await rename(destination + '.partial', destination);
  const checksum = createHash('sha256').update(await readFile(destination)).digest('hex');
  await writeFile(destination + '.sha256', checksum + '  ' + title + '.zip\n');
  console.log(destination + ' ' + checksum);
} finally { await rm(temp, { recursive: true, force: true }); }
