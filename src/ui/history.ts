import './style.css';
import { MODES } from '../shared/config';
import type { DisplayMode } from '../shared/config';
import { captionText, exportSubtitles } from '../shared/history';
import type { Format, HistorySession } from '../shared/history';
import { element, fill, input, select, send, text } from './common';

fill('mode', MODES);
let records: HistorySession[] = [];
const selected = new Set<string>();
const current = () => records.find(item => item.id === select('session').value);
const mode = () => select('mode').value as DisplayMode;
const report = (value: string) => text('info', value);

function rows() {
  const session = current();
  const query = input('search').value.trim().toLocaleLowerCase();
  return (session?.entries ?? []).filter(item => !query ||
    (item.original + '\n' + (item.translation ?? '')).toLocaleLowerCase().includes(query));
}

function draw() {
  const currentRows = rows();
  const list = currentRows.slice(-300);
  const session = current();
  const selection = session?.id ?? '';
  element('list').replaceChildren(...list.map(entry => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const check = document.createElement('input');
    check.type = 'checkbox'; check.setAttribute('aria-label','选择字幕');
    const key = selection + '/' + entry.id;
    check.checked = selected.has(key);
    check.onchange = () => { if (check.checked) selected.add(key); else selected.delete(key); };
    const item = document.createElement('div');
    const at = document.createElement('small');
    at.textContent = ((entry.time - (session?.startedAt ?? entry.time)) / 1000).toFixed(1) + ' 秒 · 段 ' +
      (entry.revision + 1) + ' · ' + (entry.source === 'native' ? '原生' : '音频');
    const content = document.createElement('p');
    content.textContent = captionText(entry, mode()) || '此片段没有译文';
    item.append(at, content);
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'quiet'; copy.textContent = '复制';
    copy.onclick = () => { void navigator.clipboard.writeText(captionText(entry, mode())).then(() => report('已复制字幕。')); };
    row.append(check, item, copy);
    return row;
  }));
  report(currentRows.length === list.length ? list.length + ' 条字幕' : '显示最后 300 条，共 ' + currentRows.length + ' 条匹配字幕');
}

function timelines() {
  const old = select('timeline').value;
  const segments = [...new Set(current()?.entries.filter(entry => entry.mediaStart !== null).map(entry => entry.revision) ?? [])];
  fill('timeline', { session: '会话相对时间 · 含全部跳转', ...Object.fromEntries(segments.map(number => ['segment-' + number, '媒体时间 · 段 ' + (number + 1)])) });
  if (Array.from(select('timeline').options).some(option => option.value === old)) select('timeline').value = old;
  else if (segments.length === 1) select('timeline').value = 'segment-' + segments[0];
}

async function refresh() {
  try {
    const next = await send<HistorySession[]>({ op: 'history' });
    const keys = (all: HistorySession[]) => JSON.stringify(all.map(item => [item.id, item.entries.length, item.entries.at(-1)?.id, item.entries.at(-1)?.translation]));
    if (keys(next) === keys(records)) return;
    const old = select('session').value;
    records = next;
    fill('session', Object.fromEntries(records.map(item => [item.id, item.title + ' · ' + new Date(item.startedAt).toLocaleTimeString()])));
    if (records.some(item => item.id === old)) select('session').value = old;
    timelines();
    draw();
  } catch { report('字幕记录暂时无法读取。'); }
}

for (const format of ['txt','srt','vtt'] as Format[]) element(format).addEventListener('click', () => {
  const record = current();
  if (!record?.entries.length) { report('当前会话没有可导出的字幕。'); return; }
  const timeline = select('timeline').value;
  const value = exportSubtitles(record, format, mode(), timeline === 'session' ? undefined : Number(timeline.slice(8)));
  const href = URL.createObjectURL(new Blob([value], { type: format === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' }));
  const save = document.createElement('a');
  save.href = href;
  save.download = 'HoriSub-' + new Date(record.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.' + format;
  save.click();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
});
element('search').addEventListener('input', draw);
element('mode').addEventListener('change', draw);
element('session').addEventListener('change', () => { timelines(); draw(); });
element('copy-selected').addEventListener('click', () => {
  const session = current();
  const value = session?.entries.filter(row => selected.has(session.id + '/' + row.id)).map(row => captionText(row, mode())).join('\n\n');
  if (value) void navigator.clipboard.writeText(value).then(() => report('已复制选中的字幕。'));
});
element('clear').addEventListener('click', () => {
  if (!confirm('清除当前会话和本机保存的字幕历史？')) return;
  void send({ op: 'clear-history' }).then(refresh);
});
draw();
void refresh();
setInterval(() => { void refresh(); }, 1600);
