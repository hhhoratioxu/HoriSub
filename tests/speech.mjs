import assert from 'node:assert/strict';
import { setup } from './chrome-core.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';
import { until } from './chrome-launch.mjs';

const mode = process.argv.includes('--browser') ? 'browser' : 'native';
const audio = process.argv.includes('--audio');
const env = await setup(mode);
const { player, options } = env;
try {
  const voices = await until(async () => {
    const names = await options.locator('#voice option').allTextContents();
    return names.length > 1 && names;
  }, 'available local Chinese voices', 25_000);
  console.log(env.chrome.version.product, mode, 'offline voices:', voices.length - 1);
  await options.selectOption('#source', 'en');
  if (!audio) await options.selectOption('#captionSource', 'native');
  if (mode === 'native') {
    const voice = await options.locator('#voice option[value^="system:"]').evaluateAll(items =>
      (items.find(item => item.textContent.endsWith(' · zh-CN')) || items[0])?.value);
    assert(voice);
    await options.selectOption('#voice', voice);
  }
  await options.evaluate(() => {
    document.querySelector('#speak').checked = true;
    document.querySelector('#speechVolume').value = '15';
  });
  await options.locator('#save').click();
  await player.goto(env.site.url + (audio ? '/fixture?soak' : '/fixture?soak&native'));
  const id = await env.start();
  await muteMonitorForLongTest(env);
  await until(async () => (await env.status(id)).live?.phase === 'paused', 'engine ready on a paused player', 145_000);
  await player.locator('#play').click();
  const translated = await until(async () => (await env.message('history'))[0]?.entries.find(entry => entry.translation),
    'real translation in history', 125_000);
  assert.equal(translated.source, audio ? 'audio' : 'native');
  const current = await until(async () => {
    const { live } = await env.status(id);
    if (live?.speechIssue) throw Object.assign(new Error(live.speechIssue.text), { permanent: true });
    return live?.diagnostics?.spoken > 0 && live;
  }, 'translated caption spoken in local Chinese voice', 90_000);
  assert.equal(current.speechIssue, undefined);
  console.log('Voice completed for translated caption', current.actualSource, current.diagnostics.spoken);
  await env.message('stop', { tabId: id });
  assert(!(await env.status(id)).live);
  console.log('Stopped speech and released capture');
} catch (error) {
  console.error(JSON.stringify(await env.status()), await env.lines());
  throw error;
} finally { await env.close(); }
