import type { Caption, SessionRef } from '../shared/protocol';
import type { HistorySession } from '../shared/history';
import { loadSettings } from './storage';

const key = 'captionHistory';
let work: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = work.then(task);
  work = next.catch(() => {});
  return next;
}

async function localHistory() {
  const value = (await chrome.storage.local.get(key))[key];
  return Array.isArray(value) ? value as HistorySession[] : [];
}

async function current() {
  return (await chrome.storage.session.get(key))[key] as HistorySession | undefined;
}

export function remember(ref: SessionRef, caption: Caption) {
  if (caption.kind !== 'final' || !caption.original) return;
  return serialize(async () => {
    const existing = await current();
    const session = existing?.id === ref.id ? existing : { id: ref.id, title: ref.title, startedAt: ref.startedAt, entries: [] };
    const index = session.entries.findIndex(entry => entry.id === caption.id);
    const entry = {
      id: caption.id, version: caption.version, revision: caption.playbackRevision, time: caption.startedAt,
      end: caption.speechEndAt, mediaStart: caption.mediaTime, mediaEnd: caption.mediaEndTime,
      original: caption.original.slice(0, 900), translation: caption.translation?.slice(0, 900), source: caption.source,
    };
    const previous = session.entries[index];
    if (previous && (previous.version > entry.version || (previous.translation && !entry.translation))) return;
    if (index === -1) session.entries.push(entry);
    else session.entries[index] = entry;
    session.entries.sort((a, b) => a.time - b.time);
    if (session.entries.length > 1600) session.entries.splice(0, session.entries.length - 1600);
    await chrome.storage.session.set({ [key]: session });
    if ((await loadSettings()).keepHistory) {
      const old = await localHistory();
      await chrome.storage.local.set({ [key]: [session, ...old.filter(item => item.id !== session.id)].slice(0, 4) });
    }
  });
}

export function histories() {
  return serialize(async () => {
    const [live, stored] = await Promise.all([current(), localHistory()]);
    return live ? [live, ...stored.filter(item => item.id !== live.id)] : stored;
  });
}

export function clearHistories() {
  return serialize(async () => {
    await Promise.all([chrome.storage.session.remove(key), chrome.storage.local.remove(key)]);
  });
}
