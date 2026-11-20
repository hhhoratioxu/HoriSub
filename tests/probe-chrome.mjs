import { setup } from './chrome-core.mjs';
const mode = process.argv[2] || 'native';
const env = await setup(mode);
try {
  console.log(env.chrome.version.product, mode);
  if (mode === 'native') console.log('Native host:', await env.options.locator('#host-status').innerText());
  console.log('Models:', await env.options.locator('.model-state').allTextContents());
  await env.options.locator('#selftest').click();
  await env.options.waitForFunction(() => !document.querySelector('#selftest').disabled, undefined, { timeout: 165_000 });
  console.log(await env.options.locator('#test-result').innerText());
  const failure = await env.options.locator('#test-result.failure').count();
  if (failure) process.exitCode = 2;
} finally { await env.close(); }
