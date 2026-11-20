import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';

const env = await setup('native');
const { player, options, message } = env;
const stall = process.argv.includes('--stall');
let stopped;

function engineProcesses() {
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
    .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, parent, file]) => ({ pid: Number(pid), parent: Number(parent), file }));
  const hosts = processes.filter(({ parent, file }) => parent === env.chrome.pid && /HoriSub.*\/runtime\/node$/.test(file));
  for (const host of hosts) {
    const child = processes.find(({ parent, file }) => parent === host.pid && /\/horisub-whisper(?:-metal)?$/.test(file));
    if (child) return { host: host.pid, recognizer: child.pid };
  }
}

try {
  await player.goto('chrome://version');
  await env.chrome.activate(player);
  const [{ id: internal }] = await options.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
  const denied = await message('start', { tabId: internal });
  assert.equal(denied?.problem?.code, 'unsupported');
  assert.equal((await options.evaluate(() => chrome.tabCapture.getCapturedTabs())).length, 0);
  console.log('Chrome internal page was refused before starting any capture');

  await player.goto(env.site.url + '/fixture?soak');
  const id = await env.start();
  await muteMonitorForLongTest(env);
  await player.locator('#play').click();
  await env.getCaption(id, 190_000);
  const current = (await env.status(id)).live;
  stopped = await until(engineProcesses, 'native host in the dedicated Chrome process');
  process.kill(stall ? stopped.recognizer : stopped.host, stall ? 'SIGSTOP' : 'SIGKILL');
  const replacement = await until(async () => {
    await wait(350);
    const value = engineProcesses();
    return value && value.host !== stopped.host && value;
  }, 'replacement native host', 165_000);
  assert.notEqual(replacement.recognizer, stopped.recognizer);
  await env.getCaption(id, 150_000);
  const recovered = (await env.status(id)).live;
  assert.equal(recovered.session.id, current.session.id);
  assert(recovered.generation > current.generation);
  console.log(stall ? 'Unresponsive native recognizer was replaced and captions resumed on the same session' :
    'Forced native host exit recovered on the same session and resumed captions');
  await message('stop', { tabId: id });
  assert(!(await env.status(id)).live);
} catch (error) {
  console.error(JSON.stringify(await env.status()), await env.lines());
  throw error;
} finally {
  if (stall && stopped && engineProcesses()?.recognizer === stopped.recognizer) process.kill(stopped.recognizer, 'SIGCONT');
  await env.close();
}
