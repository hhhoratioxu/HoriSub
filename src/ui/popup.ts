import './style.css';
import { DEFAULT_SETTINGS, MODES, RUN_MODES, SOURCES, TARGETS } from '../shared/config';
import type { DisplayMode, Source, Target } from '../shared/config';
import { browserStatus } from '../local/models';
import type { ModelStatus } from '../local/models';
import { nativeRpc, probeHost } from '../local/rpc';
import { issueFrom } from '../shared/errors';
import type { Diagnostics, PopupState, Timing } from '../shared/protocol';
import { element, fill, input, select, send, text } from './common';

const action = element<HTMLButtonElement>('action');
const drag = element<HTMLButtonElement>('drag');
const notice = element('notice');
const metrics = element('metrics');
const stateDot = element('indicator');
let state: PopupState = { settings: DEFAULT_SETTINGS, live: null };
let tab: chrome.tabs.Tab | undefined;
let busy = false;
let polling = false;
let operationError = '';
let revision = 0;

fill('source', SOURCES);
fill('target', TARGETS);
fill('mode', MODES);
const phases = {
  starting: '正在获取标签页音频', loading: '模型加载中', listening: '正在识别',
  silent: '静音，等待讲话', paused: '播放暂停或已静音', retrying: '重连中', error: '连接失败',
};

function hostname(raw: string) {
  try { return new URL(raw).hostname; }
  catch { return ''; }
}

async function modelState() {
  const settings = state.settings;
  try {
    const keys = [settings.runMode === 'native' ? settings.nativeModel : settings.browserModel, settings.translator] as const;
    let checks: ModelStatus[];
    if (settings.runMode === 'browser') checks = await Promise.all(keys.map(key => browserStatus(key)));
    else {
      const link = nativeRpc();
      try {
        await probeHost(link);
        checks = await Promise.all(keys.map(model => link.call<ModelStatus>('status', { model }, { timeout: 10_000 })));
      } finally { link.close(); }
    }
    text('model-ready', checks.every(item => item.ready) ? '所选模型已准备' : '模型未准备 · 打开设置下载');
  } catch (error) { text('model-ready', issueFrom(error, 'host_missing').text); }
}

function drawMetrics(diagnostics: Diagnostics) {
  const labels: Record<Timing, string> = { capture: '分段时长', inference: '识别推理', asr: '提交至确认', translation: '翻译含排队', render: '结果至显示', total: '语音结束至译文显示' };
  const values = Object.entries(diagnostics.timings).map(([key, value]) => {
    const row = document.createElement('div');
    row.textContent = labels[key as Timing] + '  p50 ' + value.p50 + ' / p95 ' + value.p95 + ' ms  (' + value.count + ' 条)';
    return row;
  });
  const queue = document.createElement('div');
  queue.textContent = '翻译队列 ' + diagnostics.queue + ' / 峰值 ' + diagnostics.queueMax +
    ' · 已提交 ' + diagnostics.turns + ' · 已显示译文 ' + diagnostics.delivered + ' · 已丢弃 ' + diagnostics.discarded;
  metrics.replaceChildren(...values, queue);
}

function paint() {
  const { settings, live, issue, viewerIssue } = state;
  const here = !!live && live.session.tabId === tab?.id;
  const usable = !!tab?.id && (!tab.url || /^https?:/.test(tab.url));
  const problem = operationError ||
    (here ? [live.issue?.text, live.translationIssue?.text, live.speechIssue?.text, live.speedIssue?.text, viewerIssue].filter(Boolean).join(' ') : issue?.text) ||
    (!usable ? '请在播放网页视频的标签页打开 HoriSub。' : '');
  notice.hidden = !problem;
  notice.textContent = problem;
  text('site', hostname(tab?.url ?? '') || '当前标签页');
  text('page', tab?.title || '网页播放器');
  text('service', RUN_MODES[here ? live.runMode : settings.runMode] + (here ? ' · ' + (live.actualSource === 'native' ? '原生字幕' : '标签页音频') + (live.backend ? ' · ' + live.backend : '') : ' · 识别和翻译在本机'));
  text('state', here ? (live.translating && ['listening', 'silent'].includes(live.phase) ? '正在翻译' : phases[live.phase]) :
    live ? '另一个标签页正在生成字幕' : problem && usable ? '需要检查' : '未开始');
  stateDot.dataset.state = here ? live.phase : issue || operationError ? 'error' : 'idle';
  action.textContent = here ? '停止字幕' : live ? '切换到此标签页' : '开始字幕';
  action.classList.toggle('stop', here);
  action.disabled = busy || !usable;
  drag.disabled = busy || !here;
  for (const id of ['pip','next-player']) element<HTMLButtonElement>(id).disabled = busy || !here;
  element('diagnostics').hidden = !here;
  if (here) drawMetrics(live.diagnostics);

  if (!busy) {
    select('source').value = settings.source;
    select('target').value = settings.target;
    select('mode').value = settings.appearance.mode;
    input('visible').checked = settings.appearance.visible;
    input('speech').checked = settings.speech.enabled;
  }
}

async function refresh() {
  if (busy || polling) return;
  const started = revision;
  polling = true;
  try {
    const next = await send<PopupState>({ op: 'status', tabId: tab?.id });
    if (started === revision && !busy) { state = next; paint(); }
  } catch (error) {
    if (started === revision && !busy) { operationError = issueFrom(error).text; paint(); }
  } finally { polling = false; }
}

async function run(operation: () => Promise<unknown>) {
  if (busy) return;
  revision++;
  busy = true;
  operationError = '';
  paint();
  try { await operation(); }
  catch (error) { operationError = issueFrom(error).text; }
  finally { busy = false; paint(); void refresh(); }
}

action.addEventListener('click', () => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  void run(() => send({ op: state.live?.session.tabId === tabId ? 'stop' : 'start', tabId }));
});
drag.addEventListener('click', () => {
  if (tab?.id !== undefined) void send({ op: 'drag', tabId: tab.id }).then(() => window.close());
});
element('options').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
for (const id of ['source', 'target', 'mode', 'visible', 'speech']) {
  element(id).addEventListener('change', () => {
    const values = {
      source: select('source').value as Source, targetLanguage: select('target').value as Target,
      mode: select('mode').value as DisplayMode, visible: input('visible').checked, speech: input('speech').checked,
    };
    void run(() => send({ op: 'quick', ...values }));
  });
}

for (const op of ['pip','next-player'] as const) element(op).addEventListener('click', () => {
  if (tab?.id !== undefined) void send({ op, tabId: tab.id }).then(() => window.close());
});
element('history').addEventListener('click', () => { void chrome.tabs.create({ url: 'history.html' }); });
element('caption-window').addEventListener('click', () => { void send({ op: 'caption-window' }); });
[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
await refresh();
void modelState();
setInterval(() => { void refresh(); }, 800);
