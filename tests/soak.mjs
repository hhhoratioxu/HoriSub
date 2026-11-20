import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';

const args = process.argv.slice(2);
const mode = args.includes('--browser') ? 'browser' : 'native';
const measureMemory = args.includes('--memory');
const expectHostExit = args.includes('--expect-host-exit');
const duration = Math.max(1, Number(args.find(value => !value.startsWith('--'))) || 60) * 60_000;
const env = await setup(mode);
function memory(pid) {
  const rows = execFileSync('ps', ['-axo','pid,ppid,rss,comm'], { encoding: 'utf8' }).trim().split('\n').slice(1)
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(match => ({pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]), name: match[4]}));
  const tree = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (tree.has(row.parent) && !tree.has(row.pid)) { tree.add(row.pid); changed = true; }
  }
  const subtree = rows.filter(row => tree.has(row.pid));
  const hosts = subtree.filter(row => /\/engine\/runtime\/node(?:\.exe)?$/i.test(row.name));
  const recognizers = subtree.filter(row => /\/horisub-whisper(?:-metal|\.exe)?$/i.test(row.name));
  const miB = list => Math.round(list.reduce((sum, row) => sum + row.rss, 0) / 1024);
  return {
    chromeTreeMiB: miB(subtree),
    engineMiB: miB([...hosts, ...recognizers]),
    hostProcesses: hosts.length,
    hostMiB: miB(hosts),
    recognizerMiB: miB(recognizers),
  };
}
try {
  await env.player.goto(env.site.url + '/fixture?' + (args.includes('--stream') ? 'live' : 'soak'));
  if (measureMemory) {
    await env.options.waitForFunction(() =>
      [...document.querySelectorAll('.model-state')].every(node => node.textContent.startsWith('已准备')));
    await wait(3000);
    const idle = expectHostExit
      ? await until(() => {
        const sample = memory(env.chrome.pid);
        return sample.hostProcesses === 0 && sample;
      }, 'idle settings native host exit')
      : memory(env.chrome.pid);
    console.log(JSON.stringify({ phase: 'idle-settings', ...idle }));
  }
  const id = await env.start();
  await muteMonitorForLongTest(env);
  await env.player.locator('#play').click();
  await env.popup.close();
  await env.player.bringToFront();
  console.log(JSON.stringify({ phase: 'capture-open' }));
  const warmup = setInterval(() => {
    void env.status(id).then(value => {
      const current = value.live;
      console.log(JSON.stringify({ phase: 'warm-up', session: current?.phase, backend: current?.backend,
        issue: current?.issue?.code, translation: current?.translationIssue?.code, diagnostics: current?.diagnostics }));
    }).catch(() => {});
  }, 25_000);
  let caption;
  try { caption = await env.getCaption(id, 210_000); }
  finally { clearInterval(warmup); }
  assert.match(caption.original, /[A-Za-z]{2}/);
  assert.match(caption.translation, /\p{Script=Han}/u);
  const start = Date.now();
  console.log(JSON.stringify({ phase: 'started', at: new Date(start).toISOString(), version: env.chrome.version.product, mode }));
  const log = async () => {
    const value = await env.status(id);
    assert(value.live && value.live.phase !== 'error', JSON.stringify(value));
    const media = await env.player.locator('video').evaluate(video => video.currentTime);
    const record = { seconds: Math.floor((Date.now() - start) / 1000), media, backend: value.live.backend,
      ...value.live.diagnostics, ...memory(env.chrome.pid) };
    console.log(JSON.stringify(record));
    return record;
  };
  const first = await log();
  if (expectHostExit) assert.equal(first.hostProcesses, 1, 'Settings retained a second native host during capture');
  let last = first;
  let lastCaptionProgress = first.seconds;
  let longestSampledGap = 0;
  while (Date.now() - start < duration) {
    await wait(Math.min(measureMemory ? 10_000 : 60_000, duration - (Date.now() - start)));
    const current = await log();
    if (current.seconds - last.seconds >= 5) {
      assert(current.media > last.media, 'Test player stopped advancing at ' + current.media + ' s');
    }
    if (current.delivered > last.delivered) lastCaptionProgress = current.seconds;
    longestSampledGap = Math.max(longestSampledGap, current.seconds - lastCaptionProgress);
    last = current;
  }
  assert(last.turns - first.turns >= Math.floor(duration / 60_000) * 2);
  assert(last.media - first.media >= duration / 1000 * .85);
  const history = await env.message('history');
  const rows = history.find(item => item.id)?.entries ?? [];
  assert(new Set(rows.map(row => row.id)).size === rows.length);
  assert(rows.filter(row => row.translation).length >= 5);
  const expected = process.env.HORISUB_TEST_REPEAT_PHRASE?.toLowerCase();
  const repeated = expected ? rows.filter(row => row.original.toLowerCase().split(expected).length > 3).length : undefined;
  await env.message('stop', { tabId: id });
  assert(!(await env.status(id)).live);
  assert.equal(await env.player.locator('[data-horisub="overlay"]').count(), 0);
  const capture = await env.options.evaluate(() => chrome.tabCapture.getCapturedTabs());
  assert(!capture.some(value => ['active','pending'].includes(value.status)));
  if (measureMemory) {
    await wait(3000);
    const stopped = memory(env.chrome.pid);
    console.log(JSON.stringify({ phase: 'stopped-settings', ...stopped }));
    if (expectHostExit) {
      assert.equal(stopped.hostProcesses, 0, 'Stopped capture retained a native host');
      assert.equal(stopped.engineMiB, 0, 'Stopped capture retained a native engine');
    }
  }
  const delivered = last.delivered - first.delivered;
  assert(delivered >= Math.floor(duration / 60_000) * 2, 'Too few translated captions rendered during playback');
  assert(longestSampledGap <= 150, 'No new rendered translation for too long during playback');
  assert(!repeated, 'An audio turn contained more repetitions of the fixture than its duration allows');
  console.log(JSON.stringify({ phase: 'complete', elapsed: Date.now() - start, turns: last.turns, delivered,
    longestSampledGap, repeated, historyEntries: rows.length, translatedEntries: rows.filter(row => row.translation).length, capturesReleased: true }));
} finally { await env.close(); }
