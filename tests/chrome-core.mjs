import { launch, until } from './chrome-launch.mjs';
import { fixture } from './fixture.mjs';
import catalog from '../src/local/catalog.json' with { type: 'json' };

export async function setup(mode = 'native') {
  const site = await fixture();
  const chrome = await launch();
  try {
    const player = chrome.context.pages()[0];
    const key = process.env.HORISUB_TEST_BROWSER_MODEL || 'browser-tiny';
    const options = await chrome.context.newPage();
    options.on('pageerror', error => console.error('Options:', error.message));
    await options.goto(chrome.origin + '/options.html');
    await options.waitForFunction(() => !document.querySelector('#save').disabled);
    if (mode === 'browser') {
      await options.selectOption('#run', 'browser');
      await options.selectOption('#browserModel', key);
      if (key === 'browser-english') await options.selectOption('#source', 'en');
      const packs = Object.fromEntries([key, 'opus'].map(name => [name, catalog[name]]));
      await options.evaluate(async ({ packs, local }) => {
        const cache = await caches.open('horisub-models-v1');
        for (const [key, pack] of Object.entries(packs)) for (const file of pack.files) {
          const source = local + '/models/' + key + '/' + file.path;
          const answer = await fetch(source, { credentials: 'omit' });
          if (!answer.ok) throw new Error('Fixture returned ' + answer.status + ' for ' + file.path);
          const url = 'https://huggingface.co/' + pack.repo + '/resolve/' + pack.revision + '/' + file.path;
          await cache.put(url, new Response(answer.body, { headers: {
            'x-horisub-digest': file.sha256 ?? file.git, 'Content-Length': String(file.size),
          } }));
        }
      }, { packs, local: site.url });
    }
    if (mode === 'native' && process.env.HORISUB_TEST_NATIVE_MODEL) {
      await options.selectOption('#nativeModel', process.env.HORISUB_TEST_NATIVE_MODEL);
    }
    if (process.env.HORISUB_TEST_CPU) await options.selectOption('#backend', 'cpu');
    await options.selectOption('#captionSource', 'audio');
    await options.locator('#save').click();
    await options.waitForFunction(() => document.querySelector('#save-result').textContent === '设置已保存。');
    const popup = await chrome.context.newPage();
    popup.on('pageerror', error => console.error('Popup:', error.message));
    await popup.goto(chrome.origin + '/popup.html');
    async function message(op, args = {}) {
      return (popup.isClosed() ? options : popup).evaluate(async value => {
        const reply = await chrome.runtime.sendMessage({ target: 'worker', ...value });
        if (!reply?.ok) return { problem: reply?.issue, noReply: !reply };
        return reply.value ?? null;
      }, { op, ...args });
    }
    const start = async () => {
      await chrome.activate(player);
      const tabs = await (popup.isClosed() ? options : popup).evaluate(() => chrome.tabs.query({}));
      const tab = tabs.find(item => item.url === player.url());
      if (!tab) throw new Error('Target tab URL still inaccessible to the extension: ' + JSON.stringify(tabs.map(t => ({ title: t.title, url: t.url }))));
      const res = await message('start', { tabId: tab.id });
      if (res?.problem || !res?.session) throw new Error('Start failed: ' + JSON.stringify(res));
      return tab.id;
    };
    const status = id => message('status', { tabId: id });
    async function lines() {
      return player.evaluate(() => {
        const shadow = document.querySelector('[data-horisub="overlay"]')?.shadowRoot;
        return {
          original: shadow?.querySelector('.source span')?.textContent ?? '',
          translation: shadow?.querySelector('.translation span')?.textContent ?? '',
        };
      });
    }
    const getCaption = (id, timeout = 60_000, matches = () => true) => until(async () => {
      const state = await status(id);
      if (state.issue || state.live?.phase === 'error') {
        throw Object.assign(new Error(JSON.stringify(state.issue ?? state.live.issue)), { permanent: true });
      }
      const text = await lines();
      return text.original && text.translation && matches(text) && text;
    }, 'bilingual speech caption', timeout);
    return { site, chrome, player, options, popup, message, start, status, lines, getCaption,
      close: async () => { await chrome.close(); await site.close(); } };
  } catch (error) {
    await chrome.close();
    await site.close();
    throw error;
  }
}
