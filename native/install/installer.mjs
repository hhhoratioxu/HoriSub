import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, ...args] = process.argv.slice(2);
const platform = process.platform;
const windows = platform === 'win32';
const bundle = fileURLToPath(new URL('.', import.meta.url));
const root = windows
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'HoriSub')
  : join(homedir(), 'Library', 'Application Support', 'HoriSub');
const models = windows ? join(root, 'models') : join(homedir(), 'Library', 'Caches', 'HoriSub', 'models');
const final = join(root, 'engine');
const name = 'org.horisub.engine';
const manifest = windows ? join(root, name + '.json') :
  join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', name + '.json');
const registry = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + name;
const expected = windows ? 'x64' : 'arm64';
const engineData = JSON.parse(await readFile(new URL('./registration.json', import.meta.url), 'utf8'));

async function install() {
  if ((!windows && platform !== 'darwin') || process.arch !== expected) throw Error('Unsupported installer platform.');
  if (args.some(arg => arg.startsWith('--') && !['--extension-id','--repair'].includes(arg))) throw Error('Unknown option.');
  const index = args.indexOf('--extension-id');
  const id = index === -1 ? engineData.extensionId : args[index + 1];
  if (!/^[a-p]{32}$/.test(id ?? '')) throw Error('Supply the actual extension ID with --extension-id ID.');
  const packed = join(bundle, 'engine');
  execFileSync(join(packed, 'runtime', windows ? 'node.exe' : 'node'), [join(packed, 'native', 'host.mjs'), '--self-check'], { stdio: 'inherit' });
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, '.staging-'));
  const next = join(staging, 'new');
  const old = join(staging, 'old');
  let switched = false;
  const previous = await readFile(manifest).catch(() => null);
  try {
    await cp(packed, next, { recursive: true });
    if (existsSync(final)) await rename(final, old);
    await rename(next, final);
    switched = true;
    await mkdir(dirname(manifest), { recursive: true });
    const registration = {
      name, description: 'HoriSub private local media engine',
      path: join(final, windows ? 'horisub-engine.exe' : 'run.sh'),
      type: 'stdio', allowed_origins: ['chrome-extension://' + id + '/'],
    };
    const staged = manifest + '.tmp-' + process.pid;
    await writeFile(staged, JSON.stringify(registration, null, 2) + '\n', { mode: 0o600 });
    await rename(staged, manifest);
    if (windows) execFileSync('reg.exe', ['add', registry, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f', '/reg:64']);
    console.log('Registered ' + id + '\n' + manifest + '\nModels: ' + models);
  } catch (error) {
    if (switched) {
      await rename(final, join(staging, 'failed'));
      if (previous) await writeFile(manifest, previous, { mode: 0o600 });
      else await rm(manifest, { force: true });
    }
    if (existsSync(old) && !existsSync(final)) await rename(old, final);
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function uninstall() {
  if (windows) {
    try { execFileSync('reg.exe', ['delete', registry, '/f', '/reg:64'], { stdio: 'ignore' }); }
    catch { /* Already absent. */ }
  }
  await rm(manifest, { force: true });
  await rm(final, { recursive: true, force: true });
  if (args.includes('--purge-models')) await rm(models, { recursive: true, force: true });
  console.log('HoriSub unregistered. Model cache: ' + (args.includes('--purge-models') ? 'deleted' : 'kept at ' + models));
}
try {
  if (action === 'install' || action === 'repair') await install();
  else if (action === 'uninstall') await uninstall();
  else throw Error('Use install, repair, or uninstall.');
} catch (error) {
  console.error('Installer: ' + (error.code === 'EPERM' || error.code === 'EBUSY' ?
    'Close Chrome and retry.' : error.message));
  process.exitCode = 1;
}
