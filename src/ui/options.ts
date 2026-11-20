import './style.css';
import { CAPTION_SOURCES, DEFAULT_APPEARANCE, MODES, RUN_MODES, SOURCES, TARGETS, normalizeSettings } from '../shared/config';
import type { Appearance, Settings } from '../shared/config';
import { issueFrom, ServiceError } from '../shared/errors';
import { MODEL_PERMISSIONS, browserDownload, browserRemove, browserStatus, catalog } from '../local/models';
import type { ModelKey, ModelStatus, RunMode } from '../local/models';
import { nativeRpc, probeHost } from '../local/rpc';
import type { EngineRpc } from '../local/rpc';
import { element, fill, input, select, send, text } from './common';

const saveButton = element<HTMLButtonElement>('save');
const get = (id: string) => input(id).value;
const put = (id: string, value: number | string) => { input(id).value = String(value); };
const flag = (id: string) => input(id).checked;
const check = (id: string, value: boolean) => { input(id).checked = value; };
const number = (id: string) => input(id).valueAsNumber;
const size = (bytes: number) => (bytes / 1_000_000).toFixed(1) + ' MB';
let nativeRequests: { rpc: EngineRpc; active: number } | undefined;
let download: AbortController | undefined;
let view = 0;
let voiceView = 0;

fill('run', RUN_MODES); fill('captionSource', CAPTION_SOURCES);
fill('target', TARGETS); fill('source', SOURCES); fill('mode', MODES);
for (const [id, keys] of [
  ['nativeModel', ['native-base','native-small','native-tiny']],
  ['browserModel', ['browser-tiny','browser-base','browser-english']],
  ['translator', ['opus','m2m']],
] as const) fill(id, Object.fromEntries(keys.map(key => [key, catalog[key].label])));
text('extension-id', chrome.runtime.id);

function displayAppearance(appearance: Appearance) {
  for (const key of ['mode','size','color','opacity','outline','x','y','delay'] as const) put(key, appearance[key]);
  check('visible', appearance.visible);
}
function paint(settings: Settings) {
  put('run', settings.runMode);
  for (const key of ['source','target','captionSource','nativeModel','browserModel','translator','backend','glossary'] as const) put(key, settings[key]);
  displayAppearance(settings.appearance);
  check('speak', settings.speech.enabled); check('duck', settings.speech.duck); check('keep', settings.keepHistory);
  put('rate', settings.speech.rate); put('speechVolume', Math.round(settings.speech.volume * 100));
}
function read() {
  return normalizeSettings({
    runMode: get('run') as RunMode, source: get('source') as Settings['source'], target: get('target') as Settings['target'],
    captionSource: get('captionSource') as Settings['captionSource'], backend: get('backend') as Settings['backend'],
    nativeModel: get('nativeModel') as Settings['nativeModel'], browserModel: get('browserModel') as Settings['browserModel'],
    translator: get('translator') as Settings['translator'], glossary: get('glossary'), keepHistory: flag('keep'),
    speech: { enabled: flag('speak'), duck: flag('duck'), rate: number('rate'), volume: number('speechVolume') / 100, voice: get('voice') },
    appearance: {
      mode: get('mode') as Appearance['mode'], visible: flag('visible'), color: get('color'),
      size: number('size'), opacity: number('opacity'), outline: number('outline'), x: number('x'), y: number('y'), delay: number('delay'),
    },
  });
}

function say(id: string, value: string, failure = false) {
  element(id).hidden = !value;
  element(id).classList.toggle('failure', failure);
  text(id, value);
}
async function withNative<T>(request: (rpc: EngineRpc) => Promise<T>): Promise<T> {
  // Chrome starts a native process for the port. Share concurrent requests and release it when idle.
  const group = nativeRequests ??= { rpc: nativeRpc(), active: 0 };
  group.active++;
  try { return await request(group.rpc); }
  finally {
    if (--group.active === 0 && nativeRequests === group) {
      nativeRequests = undefined;
      group.rpc.close();
    }
  }
}

async function host() {
  const settings = read();
  element('native-status').hidden = settings.runMode !== 'native';
  if (settings.runMode !== 'native') return;
  try {
    const info = await withNative(probeHost);
    text('host-status', info.version + ' · ' + info.platform + ' · ' + info.engine + ' · ' + info.path);
  } catch (error) { text('host-status', issueFrom(error, 'host_missing').text); }
}

function modelCard(key: ModelKey, mode: RunMode, revision: number) {
  const pack = catalog[key];
  const row = document.createElement('article');
  row.className = 'model';
  const title = document.createElement('strong');
  title.textContent = pack.label;
  const source = document.createElement('p');
  source.textContent = size(pack.bytes) + ' · ' + pack.license + ' · ' + pack.revision.slice(0, 8);
  const link = document.createElement('a');
  link.href = 'https://huggingface.co/' + pack.repo;
  link.target = '_blank'; link.rel = 'noreferrer';
  link.textContent = '模型来源';
  const line = document.createElement('p');
  line.className = 'model-state'; line.textContent = '正在检测…';
  line.setAttribute('role', 'status');
  const progress = document.createElement('progress');
  progress.max = pack.bytes; progress.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'inline stacked';
  const button = (name: string) => {
    const element = document.createElement('button');
    element.type = 'button'; element.className = 'quiet'; element.textContent = name;
    actions.append(element);
    return element;
  };
  const prepare = button('下载 / 修复');
  const verify = button('校验');
  const remove = button('删除');
  const cancel = button('取消下载');
  cancel.hidden = true;
  const status = (verify = false) => mode === 'browser' ? browserStatus(key, verify) :
    withNative(rpc => rpc.call<ModelStatus>('status', { model: key, verify }, { timeout: 15_000 }));
  const output = (state: ModelStatus) => {
    line.textContent = (state.ready ? '已准备' : '待准备') + ' · ' + size(state.bytes) + ' · ' + state.path;
  };
  verify.onclick = () => {
    line.textContent = '正在校验…';
    void status(true).then(output, error => { line.textContent = issueFrom(error).text; });
  };
  remove.onclick = () => {
    if (download || !confirm('删除此模型缓存？下次使用需要重新下载。')) return;
    const task = mode === 'browser' ? browserRemove(key) : withNative(rpc => rpc.call<ModelStatus>('remove', { model: key }));
    void task.then(output, error => { line.textContent = issueFrom(error).text; });
  };
  cancel.onclick = () => download?.abort();
  prepare.onclick = () => {
    if (download) return;
    const controller = download = new AbortController();
    const update = (bytes: number, total: number) => {
      progress.max = total; progress.value = bytes; line.textContent = size(bytes) + ' / ' + size(total);
    };
    cancel.hidden = progress.hidden = false;
    void (async () => {
      try {
        if (mode === 'browser' && !await chrome.permissions.request({ origins: MODEL_PERMISSIONS })) throw new ServiceError('denied');
        const result = mode === 'browser' ? await browserDownload(key, controller.signal, update) :
          await withNative(rpc => rpc.call<ModelStatus>('download', { model: key }, {
            signal: controller.signal, progress: update, timeout: 25 * 60_000,
          }));
        output(result);
      } catch (error) { line.textContent = issueFrom(error, 'download').text; }
      finally { cancel.hidden = progress.hidden = true; download = undefined; }
    })();
  };
  row.append(title, source, link, line, progress, actions);
  void status().then(state => { if (view === revision) output(state); }, error => {
    if (view === revision) line.textContent = issueFrom(error, 'model_missing').text;
  });
  return row;
}

function renderModels() {
  const settings = read(), mode = settings.runMode;
  element('native-select').hidden = mode !== 'native';
  element('browser-select').hidden = mode !== 'browser';
  element('native-status').hidden = mode !== 'native';
  const revision = ++view;
  element('models').replaceChildren(
    modelCard(mode === 'native' ? settings.nativeModel : settings.browserModel, mode, revision),
    modelCard(settings.translator, mode, revision),
  );
}
async function loadVoices(selected: string) {
  type Voice = { id: string; name: string; locale: string };
  const revision = ++voiceView;
  const [browser, system] = await Promise.all([
    send<Voice[]>({ op: 'voices' }).catch(() => []),
    get('run') === 'native' ? withNative(rpc => rpc.call<Voice[]>('voices', undefined, { timeout: 18_000 })).catch(() => []) : [],
  ]);
  if (revision !== voiceView) return;
  const list = [...system.map(item => ({ ...item, id: 'system:' + item.id })), ...browser];
  fill('voice', { '': '自动选择已安装的离线中文声音', ...Object.fromEntries(list.map(item => [item.id, item.name + ' · ' + item.locale])) });
  if (selected && !list.some(item => item.id === selected)) select('voice').add(new Option('已选声音当前不可用', selected));
  put('voice', selected);
  text('voice-note', list.length ? '' : '未发现离线中文声音。请在 macOS 朗读内容或 Windows 语言与语音设置下载中文声音。');
}

element('form').addEventListener('submit', event => {
  event.preventDefault();
  saveButton.disabled = true;
  void send<Settings>({ op: 'save', settings: read() }).then(settings => {
    paint(settings); renderModels(); say('save-result', '设置已保存。');
  }, error => say('save-result', issueFrom(error).text, true)).finally(() => { saveButton.disabled = false; });
});

element('selftest').addEventListener('click', () => {
  const button = element<HTMLButtonElement>('selftest');
  button.disabled = true;
  say('test-result', '正在加载模型并识别本地测试语音…');
  type Probe = { original: string; translation: string; backend: string; asrMs: number; translationMs: number };
  void send<Probe>({ op: 'test' }).then(result => say('test-result',
    result.original + '\n' + result.translation + '\n' + result.backend + ' · 识别 ' + result.asrMs + ' ms · 翻译 ' + result.translationMs + ' ms'),
  error => say('test-result', issueFrom(error).text, true)).finally(() => { button.disabled = false; });
});
element('embeds').addEventListener('click', () => {
  void chrome.permissions.request({ origins: [
    'https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*', 'https://player.twitch.tv/*', 'https://player.bilibili.com/*',
  ] }).then(granted => say('test-result', granted ? '已授权这些嵌入播放器域名。' : '未授权。'));
});
for (const id of ['run','translator','nativeModel','browserModel']) element(id).addEventListener('change', () => {
  if (download) download.abort();
  if (id === 'run') {
    void host();
    void loadVoices(get('voice'));
  }
  if (id === 'browserModel' && get('browserModel') === 'browser-english') put('source','en');
  renderModels();
});
element('refresh').addEventListener('click', () => { void host(); renderModels(); });
element('reset').addEventListener('click', () => displayAppearance(DEFAULT_APPEARANCE));
element('shortcuts').addEventListener('click', () => { void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });
element('history').addEventListener('click', () => { void chrome.tabs.create({ url: 'history.html' }); });
element('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(chrome.runtime.id).then(() => text('copy','已复制'), () => text('copy','请手动复制'));
});
window.addEventListener('pagehide', () => {
  download?.abort();
  const group = nativeRequests;
  nativeRequests = undefined;
  group?.rpc.close();
});
void send<Settings>({ op: 'settings' }).then(settings => {
  paint(settings);
  fill('voice', { '': '自动选择已安装的离线中文声音' });
  saveButton.disabled = false;
  void host();
  renderModels();
  void loadVoices(settings.speech.voice);
}, error => say('save-result', issueFrom(error).text, true));
