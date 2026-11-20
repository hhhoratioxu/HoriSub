import type { DisplayMode } from './config';

export interface HistoryEntry {
  id: string; version: number; revision: number; time: number; end: number;
  mediaStart: number | null; mediaEnd: number | null; original: string; translation?: string; source: 'native' | 'audio';
}
export interface HistorySession { id: string; title: string; startedAt: number; entries: HistoryEntry[] }
export type Format = 'txt' | 'srt' | 'vtt';

export function captionText(entry: HistoryEntry, mode: DisplayMode): string {
  return (mode === 'original' ? entry.original : mode === 'translation' ? entry.translation ?? '' :
    [entry.original, entry.translation].filter(Boolean).join('\n')).trim();
}

function clock(value: number, format: Format) {
  const ms = Math.max(0, Math.round(value));
  const sections = [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60];
  return sections.map(n => String(n).padStart(2, '0')).join(':') +
    (format === 'srt' ? ',' : '.') + String(ms % 1000).padStart(3, '0');
}

export function exportSubtitles(session: HistorySession, format: Format, mode: DisplayMode, revision?: number) {
  const chosen = session.entries.filter(item => revision === undefined || item.revision === revision && item.mediaStart !== null)
    .map(item => ({ item, text: captionText(item, mode) })).filter(item => item.text);
  const media = revision !== undefined;
  const rows = chosen.map(({ item, text }) => ({
    start: Math.max(0, media ? (item.mediaStart ?? 0) * 1000 : item.time - session.startedAt),
    end: Math.max(0, media ? (item.mediaEnd ?? item.mediaStart ?? 0) * 1000 : item.end - session.startedAt),
    text: text.replace(/-->/g, '→').split('\n').filter(line => line.trim()).join('\n'),
    revision: item.revision,
  })).sort((a, b) => a.start - b.start);
  if (format === 'txt') return session.title + '\n' + (media ? '媒体时间（分段 ' + revision + '）' : '会话相对时间（按采集顺序）') + '\n\n' +
    rows.map(row => '[' + clock(row.start, 'txt') + ' · 段 ' + (row.revision + 1) + ']\n' + row.text).join('\n\n') + '\n';
  let lastStart = -1;
  const captions = rows.map((row, index) => {
    const start = Math.max(Math.round(row.start), lastStart + 1);
    lastStart = start;
    const following = rows[index + 1]?.start ?? Infinity;
    const end = Math.max(start + 1, Math.min(Math.round(following), Math.max(start + 220, Math.round(row.end))));
    const timing = clock(start, format) + ' --> ' + clock(end, format);
    const text = format === 'vtt' ? row.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') : row.text;
    return (format === 'srt' ? String(index + 1) + '\n' : '') + timing + '\n' + text;
  });
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + captions.join('\n\n') + '\n';
}
