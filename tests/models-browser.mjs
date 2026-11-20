import assert from 'node:assert/strict';
import catalog from '../src/local/catalog.json' with { type: 'json' };
import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';

const key = process.env.HORISUB_TEST_BROWSER_MODEL || 'browser-tiny';
const pack = catalog[key];
const file = pack.files.find(asset => asset.path === 'config.json');
const url = 'https://huggingface.co/' + pack.repo + '/resolve/' + pack.revision + '/' + file.path;
const env = await setup('browser');
const { options } = env;
try {
  const card = options.locator('#models .model').first();
  const state = card.locator('.model-state');
  const check = text => until(async () => (await state.innerText()).startsWith(text), 'model state ' + text, 35_000);
  await card.getByRole('button', { name:'校验' }).click();
  await check('已准备');
  await options.evaluate(async url => {
    const cache = await caches.open('horisub-models-v1');
    const entry = await cache.match(url);
    const bytes = new Uint8Array(await entry.arrayBuffer());
    bytes[0] ^= 16;
    await cache.put(url, new Response(bytes, { headers: entry.headers }));
  }, url);
  await card.getByRole('button', { name:'校验' }).click();
  await check('待准备');
  console.log('Browser settings detected the model file corruption with identical file size');
  if (process.env.HORISUB_CHROME_ONLINE) {
    await card.getByRole('button', { name:'下载 / 修复' }).click();
    await card.getByRole('button', { name:'取消下载' }).waitFor({ state:'hidden', timeout:90_000 });
    const result = await state.innerText();
    console.log('Browser repair status', result);
    assert.match(result, /^已准备/);
    await card.getByRole('button', { name:'校验' }).click();
    await check('已准备');
    console.log('Browser settings repaired the model from the pinned source and verified it');
  }
  options.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name:'删除' }).click();
  await check('待准备');
  assert.equal(await options.evaluate(async url => !!(await (await caches.open('horisub-models-v1')).match(url)), url), false);
  assert.match(await state.innerText(), /\b0\.0 MB\b/);
  console.log('Browser settings removed the selected model and updated the cache state');
} finally { await env.close(); }
