import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';

const mode = process.argv.includes('--browser') ? 'browser' : 'native';
const env = await setup(mode);
const { player, options, message } = env;
let activeTabId;
try {
  await player.goto(env.site.url + '/fixture');
  const id = activeTabId = await env.start();
  await env.popup.close();
  await muteMonitorForLongTest(env);
  await player.locator('#play').click();
  await env.getCaption(id, 200_000);
  console.log('Local speech shown', env.chrome.version.product, mode);
  const initial = (await env.status(id)).live;
  await player.locator('video').evaluate(video => {
    video.playbackRate = 1.25;
    video.currentTime = Math.min(video.duration - 1, 4);
  });
  await until(async () => (await env.status(id)).live?.playbackRevision > initial.playbackRevision, 'seek timeline changed');
  await env.getCaption(id, 100_000);
  console.log('Seek and playback rate kept the new timeline');
  await player.locator('#replace').click();
  assert(player.url().includes('watch=second'));
  await env.getCaption(id, 100_000);
  console.log('SPA and player replacement resumed on a new timeline');

  await player.locator('video').evaluate(async video => {
    video.src = '/silence.wav'; await video.play();
  });
  await until(async () => (await env.status(id)).live?.phase === 'silent', 'silence after switching media', 25_000);
  const turns = (await env.status(id)).live.diagnostics.turns;
  await wait(32_000);
  assert.equal((await env.status(id)).live.diagnostics.turns, turns);
  assert.deepEqual(await env.lines(), { original:'', translation:'' });
  await player.locator('video').evaluate(async video => {
    video.src = '/speech.wav'; await video.play();
  });
  await env.getCaption(id, 100_000);
  console.log('32 seconds of silence produced no turns; speech resumed');
  if (mode === 'browser') {
    const target = await env.chrome.context.newCDPSession(options);
    await target.send('ServiceWorker.enable');
    await target.send('ServiceWorker.stopAllWorkers');
    await target.detach();
    const current = await until(async () => (await env.status(id)).live, 'session resumed after worker stop', 20_000);
    assert.equal(current.session.id, initial.session.id);
    await env.getCaption(id, 45_000);
    console.log('Offscreen session survived service worker termination');
  }
  await message('stop',{tabId:id});
  assert(!(await env.status(id)).live);
  await options.selectOption('#captionSource','native');
  await options.locator('#save').click();
  await player.goto(env.site.url + '/fixture?native');
  const nativeId = activeTabId = await env.start();
  await muteMonitorForLongTest(env);
  await player.locator('#play').click();
  await until(async () => (await env.status(nativeId)).live?.actualSource === 'native', 'native text track selected', 100_000);
  const history = await until(async () => {
    const sessions = await message('history');
    return sessions[0]?.entries.find(entry => entry.source === 'native' && entry.translation);
  }, 'translation of an actual TextTrack cue', 65_000);
  assert.match(history.translation, /\p{Script=Han}/u);
  await message('stop',{tabId:nativeId});
  console.log('Native TextTrack source and translated caption verified');
} catch (error) {
  console.error(JSON.stringify(await env.status(activeTabId)));
  throw error;
} finally { await env.close(); }
