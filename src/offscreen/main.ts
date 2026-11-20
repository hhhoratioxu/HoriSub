import type { EngineMessage, OffscreenEvent, Reply, SessionRef } from '../shared/protocol';
import { issueFrom, ServiceError } from '../shared/errors';
import type { Issue } from '../shared/errors';
import { localProbe } from '../providers/asr';
import { CaptureSession } from './session';

let active: CaptureSession | undefined;
let testRunning = false;
const emit = (session: SessionRef, event: OffscreenEvent) => {
  void chrome.runtime.sendMessage({ target: 'worker', op: 'event', session, event }).catch(() => {});
};

async function end(session: CaptureSession, issue?: Issue) {
  if (active !== session) return;
  active = undefined;
  if (issue) emit(session.ref, { type: 'ended', issue });
  await session.stop();
}

async function handle(message: EngineMessage): Promise<unknown> {
  if (message.op === 'status') return active?.snapshot() ?? null;
  if (message.op === 'start') {
    if (active || testRunning) throw new ServiceError('busy');
    const session: CaptureSession = new CaptureSession(
      message.session, message.settings, message.playback, event => emit(message.session, event),
      issue => { void end(session, issue); },
    );
    active = session;
    void session.start(message.streamId);
    return session.snapshot();
  }
  if (message.op === 'test') {
    if (active || testRunning) throw new ServiceError('busy', '请停止字幕后再自检。');
    testRunning = true;
    try { return await localProbe(message.settings); }
    finally { testRunning = false; }
  }
  if (!active || message.id !== active.ref.id) return;
  if (message.op === 'stop') await end(active);
  if (message.op === 'update') active?.updateSettings(message.settings);
  if (message.op === 'playback') active?.updatePlayback(message.playback);
  if (message.op === 'cue') active?.nativeCue(message.cue);
  if (message.op === 'rendered') active?.rendered(message.caption, message.at);
}

chrome.runtime.onMessage.addListener((message: EngineMessage, sender, send: (reply: Reply<unknown>) => void) => {
  if (message?.target !== 'engine' || sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
  void handle(message).then(value => send({ ok: true, value }), error => send({ ok: false, issue: issueFrom(error) }));
  return true;
});
