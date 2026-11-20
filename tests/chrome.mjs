import assert from 'node:assert/strict';
import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';
import { setTimeout as wait } from 'node:timers/promises';

const mode = process.argv.includes('--browser') ? 'browser' : 'native';
const env = await setup(mode);
try {
  console.log(env.chrome.version.product, mode);
  await env.player.goto(env.site.url + '/fixture' + (process.env.HORISUB_FIXTURE_LIVE ? '?live' : ''));
  await env.player.locator('#play').click();
  const id = await env.start();
  console.log('Chrome tabCapture started', id);
  // Capture starts on a playing tab. Wait for a complete phrase from the looping clip.
  const caption = await env.getCaption(id, 150_000, ({ original, translation }) =>
    /captions|americans/i.test(original) && /\p{Script=Han}/u.test(translation));
  console.log('Verified local caption', caption);
  const startup = await env.status(id);
  console.log('Initial metrics', startup.live.backend, startup.live.diagnostics);
  const history = await env.message('history');
  assert(history[0].entries.some(entry => entry.translation === caption.translation));
  await env.message('stop', { tabId: id });
  await until(async () => !(await env.status(id)).live, 'stop removed session');
  assert.equal(await env.player.locator('[data-horisub="overlay"]').count(), 0);
  await wait(220);
  const captured = await env.popup.evaluate(() => chrome.tabCapture.getCapturedTabs());
  assert(!captured.some(item => item.status === 'active' || item.status === 'pending'));
  console.log('Stop released capture and overlay');
} catch (error) {
  console.error('Failure', error.message, error.cause?.message, JSON.stringify(await env.status()), await env.lines());
  throw error;
} finally {
  await env.close();
}
