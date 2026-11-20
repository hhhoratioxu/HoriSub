import assert from 'node:assert/strict';
import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';

const env = await setup('browser');
try {
  await env.player.goto(env.site.url + '/embedded');
  const frame = env.player.frameLocator('iframe');
  const id = await env.start();
  assert((await env.status(id)).live.session.frameId > 0);
  await muteMonitorForLongTest(env);
  await frame.locator('#play').click();
  await until(async () => {
    const line = await frame.locator('[data-horisub="overlay"]').evaluate(element =>
      element.shadowRoot.querySelector('.translation span')?.textContent);
    return /\p{Script=Han}/u.test(line ?? '');
  }, 'same-origin embedded video has local translation', 115_000);
  console.log('Same-origin embedded player was selected and rendered a real translation');
  await env.player.goto(env.site.url + '/other');
  await until(async () => !(await env.status(id)).live, 'session ended on navigation out of media');
  console.log('Navigation away stopped the captured tab');
} finally { await env.close(); }
