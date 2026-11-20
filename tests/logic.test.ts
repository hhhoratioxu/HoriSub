import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAME_BYTES, PcmEncoder } from '../src/offscreen/pcm';
import { SpeechTurns } from '../src/offscreen/turns';
import { exportSubtitles } from '../src/shared/history';
import type { HistoryEntry } from '../src/shared/history';
import type { Stamp } from '../src/shared/protocol';
import { normalizeSettings } from '../src/shared/config';

test('24 kHz mono framing keeps time at common actual audio rates', () => {
  for (const rate of [44100, 48000, 96000]) {
    let frames = 0;
    const encoder = new PcmEncoder(rate, (audio, rms) => {
      assert.equal(audio.byteLength, FRAME_BYTES);
      assert(rms > 0.1 && rms < 0.6);
      frames++;
    });
    for (let i = 0; i < rate; i++) encoder.push(Math.sin(2 * Math.PI * 440 * i / rate) * .5);
    assert.equal(frames, 25);
  }
});
test('silence never starts a turn and speech keeps pre-roll and bounded continuous windows', () => {
  const committed: Stamp[] = [];
  let began = 0, frames = 0;
  const turns = new SpeechTurns({
    begin() { began++; }, append() { frames++; }, discard() {}, commit(stamp) { committed.push(stamp); },
  });
  let at = 0;
  const add = (count: number, speech: boolean) => {
    for (let i = 0; i < count; i++) turns.feed({ pcm: new ArrayBuffer(0), at: (at += 40), speech });
  };
  add(900, false);
  assert.equal(began, 0);
  add(30, true); add(20, false);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].startedAt, 35840);
  assert(committed[0].committedAt - committed[0].speechEndAt >= 350);
  add(270, true); add(20, false);
  assert(committed.some(item => item.forced));
  assert(committed.every(item => item.committedAt - item.startedAt <= 4440));
  assert(frames < 350);
});
test('seek-delimited exports sort and share original and translation time', () => {
  const entry: HistoryEntry = {
    id: 'x', version: 1, revision: 1, time: 4000, end: 3800, mediaStart: 12.001, mediaEnd: 12.2,
    original: 'a < tag -->', translation: '中文', source: 'audio',
  };
  const session = { id: 'test', title: 'video', startedAt: 0, entries: [entry, { ...entry, revision: 2, time: 5000, mediaStart: 1 }] };
  const media = exportSubtitles(session, 'vtt', 'dual', 1);
  assert.match(media, /^WEBVTT\n\n00:00:12.001 --> 00:00:12.221/);
  assert.match(media, /a &lt; tag →\n中文/);
  const srt = exportSubtitles(session, 'srt', 'translation');
  assert.match(srt, /00:00:04,000 --> 00:00:04,220\n中文/);
  assert.match(srt, /00:00:05,000 --> 00:00:05,220\n中文/);
});
test('defaults require no credentials and Chinese speech is off', () => {
  const settings = normalizeSettings();
  assert.equal(settings.runMode, 'native');
  assert.equal(settings.target, 'zh-CN');
  assert.equal(settings.speech.enabled, false);
  assert.equal(settings.keepHistory, false);
});
