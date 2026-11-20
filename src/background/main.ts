import { normalizeSettings } from '../shared/config';
import type { Settings } from '../shared/config';
import { issueFrom, ServiceError } from '../shared/errors';
import type { Issue } from '../shared/errors';
import type {
  ContentMessage, EngineMessage, LiveState, Playback, PopupState, Reply, SessionRef, WorkerMessage,
} from '../shared/protocol';
import { loadSettings, restrictStorage, saveSettings } from './storage';
import { clearHistories, histories, remember } from './history';
import { speak, stopSpeech, voices } from './tts';

const OFFSCREEN = 'offscreen.html';
const HOST = 'org.horisub.engine';
const extensionUrl = (page: string) => chrome.runtime.getURL(page);
const activeKey = 'activeSession';
const issueKey = 'lastSessionIssue';
let operations: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const result = operations.then(task);
  operations = result.catch(() => {});
  return result;
}

async function hasEngine() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [extensionUrl(OFFSCREEN)],
  });
  return !!contexts.length;
}

async function createEngine() {
  if (!await hasEngine()) await chrome.offscreen.createDocument({
    url: OFFSCREEN, reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture the selected tab, restore playback, and prepare audio for local transcription.',
  });
}
async function closeEngine() {
  if (await hasEngine()) await chrome.offscreen.closeDocument().catch(() => {});
}
async function engine<T = void>(message: EngineMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage<EngineMessage, Reply<T>>(message);
  if (!response) throw new ServiceError('capture');
  if (!response.ok) throw new ServiceError(response.issue.code, response.issue.text);
  return response.value;
}
function frame<T = void>(tabId: number, frameId: number, message: ContentMessage): Promise<T> {
  return chrome.tabs.sendMessage<ContentMessage, T>(tabId, message, { frameId });
}
const content = <T = void>(session: SessionRef, message: ContentMessage) =>
  frame<T>(session.tabId, session.frameId, message);

async function ref() {
  await restrictStorage();
  return (await chrome.storage.session.get(activeKey))[activeKey] as SessionRef | undefined;
}

function eligible(raw?: string) {
  if (!raw) throw new ServiceError('unsupported', '请从目标标签页的 Chrome 工具栏打开 HoriSub。');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === 'chromewebstore.google.com') {
    throw new ServiceError('unsupported', 'Chrome 禁止在这个页面捕获音频。');
  }
  return url;
}

async function finish(session: SessionRef, issue?: Issue) {
  if ((await ref())?.id !== session.id) return;
  stopSpeech();
  if (await hasEngine()) await engine({ target: 'engine', op: 'stop', id: session.id }).catch(() => {});
  await chrome.storage.session.remove(activeKey);
  if (issue) await chrome.storage.session.set({ [issueKey]: { tabId: session.tabId, issue } });
  await Promise.allSettled([
    content(session, { target: 'content', op: 'remove', id: session.id }),
    chrome.action.setBadgeText({ tabId: session.tabId, text: '' }),
    closeEngine(),
  ]);
}

async function chooseFrame(tabId: number) {
  const search = async (frames: number[]) => {
    const results = await Promise.all(frames.map(async frameId => ({
      frameId, probe: await frame<{ found: boolean; area: number }>(tabId, frameId, { target: 'content', op: 'probe' }).catch(() => null),
    })));
    return results.filter(value => value.probe?.found).sort((a, b) => (b.probe?.area ?? 0) - (a.probe?.area ?? 0))[0]?.frameId;
  };
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {
    throw new ServiceError('denied');
  });
  const top = await search([0]);
  if (top !== undefined) return top;
  const available = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => []);
  return search([...new Set(available.map(value => value.frameId))]);
}

async function start(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = eligible(tab?.url);
  const old = await ref();
  if (old?.tabId === tabId && await hasEngine()) {
    const live = await engine<LiveState | null>({ target: 'engine', op: 'status' }).catch(() => null);
    if (live?.session.id === old.id) return live;
  }
  const settings = await loadSettings();
  const frameId = await chooseFrame(tabId);
  if (frameId === undefined) throw new ServiceError('unsupported',
    '没有找到可访问的播放器。嵌入式播放器可能需要站点授权，或在独立标签页打开。');
  if (old) await finish(old);
  const session: SessionRef = {
    tabId, id: crypto.randomUUID(), origin: url.origin, frameId, startedAt: Date.now(), title: tab?.title ?? url.hostname,
  };
  await chrome.storage.session.set({ [activeKey]: session });
  await chrome.storage.session.remove(issueKey);
  try {
    const mounted = await content<{ playback: Playback } | null>(session, {
      target: 'content', op: 'mount', id: session.id, appearance: settings.appearance, captionSource: settings.captionSource,
    });
    if (!mounted) throw new ServiceError('unsupported');
    await createEngine();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }).catch(() => {
      throw new ServiceError('capture', 'Chrome 未授权捕获。请从目标视频的工具栏打开 HoriSub。');
    });
    return await engine<LiveState>({ target: 'engine', op: 'start', session, streamId, settings, playback: mounted.playback });
  } catch (error) {
    await finish(session, issueFrom(error, 'capture'));
    throw error;
  }
}

async function status(tabId?: number): Promise<PopupState> {
  const [settings, session] = await Promise.all([loadSettings(), ref()]);
  let live: LiveState | null = null;
  let viewerIssue: string | undefined;
  if (session) {
    if (await hasEngine()) live = await engine<LiveState | null>({ target: 'engine', op: 'status' }).catch(() => null);
    if (live?.session.id === session.id) {
      viewerIssue = (await content<{ viewerIssue?: string }>(session, { target: 'content', op: 'probe' }).catch(() => null))?.viewerIssue;
    } else if (!await hasEngine()) {
      live = null;
      await serial(async () => { if (!await hasEngine()) await finish(session, issueFrom(null, 'capture')); });
    }
  }
  const last = (await chrome.storage.session.get(issueKey))[issueKey] as { tabId: number; issue: Issue } | undefined;
  return { settings, live, issue: last?.tabId === tabId ? last?.issue : undefined, viewerIssue };
}

async function apply(settings: Settings) {
  await saveSettings(settings);
  const session = await ref();
  if (!session) return;
  await Promise.allSettled([
    hasEngine().then(async exists => {
      if (exists) await engine({ target: 'engine', op: 'update', id: session.id, settings });
    }),
    content(session, { target: 'content', op: 'style', id: session.id, appearance: settings.appearance, captionSource: settings.captionSource }),
  ]);
}

async function testLocal() {
  if (await ref()) throw new ServiceError('busy', '请停止字幕后再自检。');
  const settings = await loadSettings();
  await createEngine();
  try { return await engine({ target: 'engine', op: 'test', settings }); }
  finally { await closeEngine(); }
}

function sameSite(raw: string, origin: string) {
  try { return new URL(raw).origin === origin; } catch { return false; }
}

async function handle(message: WorkerMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (message.op === 'event') {
    if (sender.url !== extensionUrl(OFFSCREEN)) return;
    const { session, event } = message;
    if ((await ref())?.id !== session.id) return;
    if (event.type === 'ended') return serial(() => finish(session, event.issue));
    if (event.type === 'phase') {
      const text = { starting: '…', loading: '…', paused: 'Ⅱ', silent: '·', retrying: '↻', listening: 'CC', error: '!' };
      void chrome.action.setBadgeText({ tabId: session.tabId, text: text[event.phase] }).catch(() => {});
    }
    if (event.type === 'frame' && event.caption.kind === 'final') void remember(session, event.caption)?.catch(() => {});
    return content(session, { target: 'content', op: 'event', id: session.id, event }).catch(() => {});
  }

  if (message.op === 'speak' || message.op === 'stop-speech') {
    if (sender.url !== extensionUrl(OFFSCREEN) || (await ref())?.id !== message.id) return;
    if (message.op === 'stop-speech') return stopSpeech();
    return speak(message.text, message.speech, message.language);
  }

  if (message.op === 'playback' || message.op === 'position' || message.op === 'rendered' || message.op === 'leave' || message.op === 'cue' || message.op === 'open-subtitle-window') {
    const session = await ref();
    if (!session || sender.frameId !== session.frameId || sender.tab?.id !== session.tabId || message.id !== session.id) return;
    if (message.op === 'leave') return serial(() => finish(session));
    if (message.op === 'open-subtitle-window') return chrome.windows.create({ url: 'captions.html', type: 'popup', width: 545, height: 270 });
    if (message.op === 'position') return serial(async () => {
      const settings = await loadSettings();
      await apply(normalizeSettings({ ...settings, appearance: { ...settings.appearance, x: message.x, y: message.y } }));
    });
    if (message.op === 'playback' || message.op === 'cue') return serial(async () => {
      if (!await hasEngine()) return;
      if (message.op === 'playback') await engine({ target: 'engine', op: 'playback', id: session.id, playback: message.playback });
      else await engine({ target: 'engine', op: 'cue', id: session.id, cue: message.cue });
    });
    if (await hasEngine()) return engine({ target: 'engine', op: 'rendered', id: session.id, caption: message.caption, at: message.at });
    return;
  }

  if (!['popup.html','options.html','history.html','captions.html'].some(page => sender.url === extensionUrl(page))) {
    throw new ServiceError('denied');
  }
  if (message.op === 'settings') return loadSettings();
  if (message.op === 'status') return status(message.tabId);
  if (message.op === 'voices') return voices();
  if (message.op === 'history') return histories();
  if (message.op === 'clear-history') return clearHistories();
  if (message.op === 'caption-window') return chrome.windows.create({ url: 'captions.html', type: 'popup', width: 545, height: 270 });

  return serial(async () => {
    switch (message.op) {
      case 'save': await apply(normalizeSettings(message.settings)); return loadSettings();
      case 'quick': {
        const settings = await loadSettings();
        await apply(normalizeSettings({
          ...settings, source: message.source, target: message.targetLanguage, speech: { ...settings.speech, enabled: message.speech },
          appearance: { ...settings.appearance, mode: message.mode, visible: message.visible },
        }));
        break;
      }
      case 'start': return start(message.tabId);
      case 'stop': {
        const session = await ref();
        if (session?.tabId === message.tabId) await finish(session);
        await chrome.storage.session.remove(issueKey);
        break;
      }
      case 'drag': case 'pip': case 'next-player': {
        const session = await ref();
        if (session?.tabId === message.tabId) return content(session, { target: 'content', op: message.op, id: session.id });
        break;
      }
      case 'test': return testLocal();
    }
  });
}

chrome.runtime.onMessage.addListener((message: WorkerMessage, sender, send: (reply: Reply<unknown>) => void) => {
  if (message?.target !== 'worker' || sender.id !== chrome.runtime.id) return;
  void handle(message, sender).then(value => send({ ok: true, value }), error => send({ ok: false, issue: issueFrom(error) }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  const origin = port.sender?.url;
  if (port.name !== 'horisub-native-v1' || port.sender?.id !== chrome.runtime.id ||
      (origin !== extensionUrl(OFFSCREEN) && origin !== extensionUrl('options.html') && origin !== extensionUrl('popup.html'))) return;
  const native = chrome.runtime.connectNative(HOST);
  const operations = new Set(['hello','status','download','remove','cancel','voices']);
  let responded = false;
  let alive = true;
  native.onMessage.addListener(message => {
    responded = true;
    if (alive) port.postMessage(message);
  });
  native.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? '';
    if (!alive) return;
    const missing = !responded && /not found|forbidden|access|failed to start/i.test(reason);
    // The terminal error applies to every request sharing this port.
    port.postMessage({ id: 0, code: missing ? 'host_missing' : 'engine_exit' });
    port.disconnect();
  });
  port.onMessage.addListener(message => {
    if (origin === extensionUrl('popup.html') && !['hello','status','cancel'].includes(message?.op)) return;
    if (origin !== extensionUrl(OFFSCREEN) && !operations.has(message?.op)) return;
    if (typeof message?.id !== 'number' || JSON.stringify(message).length > 84_000) return;
    if (alive) native.postMessage(message);
  });
  port.onDisconnect.addListener(() => { alive = false; native.disconnect(); });
});

chrome.tabs.onRemoved.addListener(tabId => { void serial(async () => {
  const session = await ref();
  if (session?.tabId === tabId) await finish(session);
}).catch(() => {}); });
chrome.tabs.onReplaced.addListener((_added, removed) => { void serial(async () => {
  const session = await ref();
  if (session?.tabId === removed) await finish(session);
}).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'loading') return;
  void serial(async () => {
    const session = await ref();
    if (session?.tabId !== tabId) return;
    if (change.url && !sameSite(change.url, session.origin)) return finish(session);
    if (change.status === 'loading') {
      const viewer = await content(session, { target: 'content', op: 'probe' }).catch(() => null);
      if (!viewer) await finish(session);
    }
  }).catch(() => {});
});
chrome.tabCapture.onStatusChanged.addListener(({ tabId, status: captureStatus }) => {
  if (captureStatus !== 'stopped' && captureStatus !== 'error') return;
  // The offscreen document reports its concrete cause before the capture status settles.
  setTimeout(() => { void serial(async () => {
    const session = await ref();
    if (session?.tabId !== tabId) return;
    const tabs = await chrome.tabCapture.getCapturedTabs();
    if (!tabs.some(tab => tab.tabId === tabId && ['active','pending'].includes(tab.status))) {
      await finish(session, issueFrom(null, 'capture'));
    }
  }).catch(() => {}); }, 400);
});
chrome.commands.onCommand.addListener(command => {
  if (command !== 'toggle-captions') return;
  void serial(async () => {
    const settings = await loadSettings();
    settings.appearance.visible = !settings.appearance.visible;
    await apply(settings);
  }).catch(() => {});
});
