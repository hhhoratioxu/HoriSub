import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { setup } from './chrome-core.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';
import { until } from './chrome-launch.mjs';

const mode = process.argv.includes('--browser') ? 'browser' : 'native';
const env = await setup(mode);
const { player, options, message } = env;
try {
  await mkdir('test-results', { recursive:true });
  await options.screenshot({ path:'test-results/options.png', fullPage: true });
  console.log('Chrome', env.chrome.version.product, mode);
  await options.locator('#keep').check();
  await options.locator('#save').click();
  await player.goto(env.site.url + '/fixture?live');
  await player.locator('#play').click();
  const id = await env.start();
  const monitorPeak = await muteMonitorForLongTest(env, true);
  console.log('Original audio reached the independent monitor at unity gain; peak', monitorPeak.toFixed(3));
  await env.popup.close();
  await player.bringToFront();
  await env.getCaption(id, 190_000);
  console.log('Caption continued after popup closed');
  await player.locator('#theater').click();
  assert(await player.locator('main').evaluate(main => main.classList.contains('theater')));
  await env.getCaption(id, 45_000);
  await player.locator('#full').click();
  await player.waitForFunction(() => document.fullscreenElement?.querySelector('[data-horisub="overlay"]'));
  await env.getCaption(id, 45_000);
  await player.screenshot({ path:'test-results/fullscreen.png' });
  await player.evaluate(() => document.exitFullscreen());
  console.log('Theater and container-fullscreen retained subtitles');

  await message('pip', { tabId:id });
  await player.getByRole('button',{name:'打开字幕画中画'}).click();
  const pip = await until(() => player.evaluate(() => {
    const page = window.documentPictureInPicture?.window;
    return page && !!page.document.querySelector('canvas');
  }), 'Document PiP video canvas', 9000);
  assert(pip);
  await until(() => player.evaluate(() => {
    const doc = window.documentPictureInPicture?.window?.document;
    return !!doc?.querySelector('aside p:last-child span')?.textContent;
  }), 'Document PiP translated caption', 45_000);
  await player.evaluate(() => window.documentPictureInPicture.window.close());
  assert(await player.locator('video').evaluate(video => video.isConnected && !video.paused));
  console.log('Document PiP mirrored live video with subtitles; close restored page-only playback');
  const opened = env.chrome.context.waitForEvent('page');
  await message('caption-window');
  const standalone = await opened;
  await standalone.waitForURL(env.chrome.origin + '/captions.html');
  await standalone.waitForFunction(() => !!document.querySelector('#translation')?.textContent, undefined, { timeout: 45_000 });
  await standalone.close();
  await player.bringToFront();
  console.log('The independent subtitles window displayed real translated captions');

  const first = (await env.status(id)).live.playbackRevision;
  await player.locator('#pause').click();
  await until(async () => (await env.status(id)).live?.phase === 'paused', 'recognizer paused');
  assert.deepEqual(await env.lines(), { original:'',translation:'' });
  await player.locator('#play').click();
  await env.getCaption(id,45_000);
  assert((await env.status(id)).live.playbackRevision > first);
  console.log('Pause, reset, and resume cleared pending subtitles');
  const histories = await message('history');
  const translated = histories[0].entries.find(entry => entry.translation);
  assert(translated);
  const records = await env.chrome.context.newPage();
  await records.goto(env.chrome.origin + '/history.html');
  await records.locator('.history-row').first().waitFor();
  for (const format of ['txt','srt','vtt']) {
    const event = records.waitForEvent('download');
    await records.locator('#' + format).click();
    const downloaded = await event;
    const content = await readFile(await downloaded.path(), 'utf8');
    assert.match(content, /\p{Script=Han}/u);
    if (format === 'vtt') assert.match(content,/^WEBVTT\n/);
    if (format === 'srt') assert.match(content,/\d{2}:\d{2}:\d{2},\d{3} --> /);
  }
  console.log('TXT, SRT and VTT downloaded and validated');
  await records.bringToFront();
  await records.locator('#search').fill('a phrase absent from the sample');
  assert.equal(await records.locator('.history-row').count(), 0);
  await records.locator('#search').fill(translated.translation);
  const result = records.locator('.history-row').first();
  await result.locator('input').check();
  await records.locator('#copy-selected').click();
  await records.waitForFunction(() => document.querySelector('#info').textContent === '已复制选中的字幕。');
  console.log('Search and selected-item copy worked on the recorded translation');
  await records.close();
  await player.bringToFront();
  await message('stop',{tabId:id});
  await wait(400);
  assert(!(await env.status(id)).live);
  const saved = await options.evaluate(async () => (await chrome.storage.local.get('captionHistory')).captionHistory);
  assert(saved.some(record => record.id === histories[0].id && record.entries.some(entry => entry.translation)));
  await message('clear-history');
  assert.deepEqual(await message('history'), []);
  console.log('Saved history could be cleared; capture and inference stopped');
} catch (error) {
  console.error(JSON.stringify(await env.status()));
  throw error;
} finally { await env.close(); }
