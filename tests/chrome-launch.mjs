import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';

export async function until(action, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {
      const value = await action();
      if (value) return value;
    } catch (problem) { if (problem.permanent) throw problem; error = problem; }
    await wait(100);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + description, { cause: error });
}

export async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'horisub-chrome-'));
  if (process.platform === 'darwin') {
    const registration = 'org.horisub.engine.json';
    const destination = join(profile, 'NativeMessagingHosts');
    await mkdir(destination);
    const nativeSource = process.env.HORISUB_TEST_REGISTRATION ||
      join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', registration);
    await copyFile(nativeSource,
      join(destination, registration)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  const executable = process.env.HORISUB_CHROME ?? chromium.executablePath();
  const child = spawn(executable, [
    ...(process.env.HORISUB_TEST_HEADFUL ? [] : ['--headless']), '--no-first-run', '--no-default-browser-check',
    ...(process.env.HORISUB_TEST_HTTP_ONLY ? ['--disable-quic'] : []),
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-networking', '--disable-default-apps', '--disable-sync', '--enable-unsafe-extension-debugging',
    ...(process.env.HORISUB_CHROME_ONLINE ? [] : ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']),
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2700); });
  const exited = once(child, 'exit');
  let browser;
  const close = async () => {
    await browser?.close().catch(() => {});
    child.kill();
    await Promise.race([exited, wait(2000)]);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const port = await until(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]),
      'Chrome DevTools port', 55_000);
    const debugUrl = 'http://127.0.0.1:' + port;
    browser = await chromium.connectOverCDP(debugUrl, { timeout: 65_000 });
    const context = browser.contexts()[0];
    const cdp = await browser.newBrowserCDPSession();
    const build = resolve(process.env.HORISUB_TEST_DIST ?? 'dist');
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: build });
    const version = await cdp.send('Browser.getVersion');
    const worker = async () => until(() => context.serviceWorkers().find(item => item.url().endsWith('/background.js')), 'extension service worker');
    const origin = 'chrome-extension://' + id;
    async function activate(page) {
      await page.bringToFront();
      const tab = await context.newCDPSession(page);
      const { targetInfo } = await tab.send('Target.getTargetInfo');
      await tab.detach();
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
      const target = targetInfos.find(info => info.url === targetInfo.url) ?? targetInfos.find(info => info.title === targetInfo.title);
      if (!target) throw new Error('No Chrome tab target corresponding to ' + targetInfo.url + ': ' + JSON.stringify(targetInfos));
      await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
      return targetInfo;
    }
    return { id, origin, debugUrl, context, cdp, version, worker, close, activate, pid: child.pid };
  } catch (error) {
    await close();
    if (diagnostic) console.error('Chrome startup:', diagnostic);
    throw error;
  }
}
