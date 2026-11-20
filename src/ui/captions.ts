import './style.css';
import type { PopupState } from '../shared/protocol';
import type { HistorySession } from '../shared/history';
import { send, text } from './common';

async function update() {
  const [{ live, settings }, history] = await Promise.all([
    send<PopupState>({ op: 'status' }), send<HistorySession[]>({ op: 'history' }),
  ]);
  const mode = settings.appearance.mode;
  const now = Date.now();
  const recent = live ? history.find(item => item.id === live.session.id)?.entries.slice(-12).reverse().filter(entry =>
    now - entry.end < 20_000 && entry.revision === live.playbackRevision && entry.id.startsWith(live.generation + ':')) ?? [] : [];
  const last = (mode !== 'original' ? recent.find(entry => entry.translation) : undefined) ?? recent[0];
  text('status', live ? '独立字幕窗' : '等待开始字幕');
  text('original', mode !== 'translation' ? last?.original ?? '' : '');
  text('translation', mode !== 'original' ? last?.translation ?? '' : '');
}
void update().catch(() => {});
setInterval(() => { void update().catch(() => {}); }, 900);
