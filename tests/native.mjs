import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

const wav = await readFile(process.argv[2] || 'public/audio/probe.wav');
const source = process.argv[3] || 'auto';
const nativeModel = process.env.HORISUB_TEST_NATIVE_MODEL || 'native-base';
const translator = ['auto', 'en'].includes(source) ? 'opus' : 'm2m';
let sound;
for (let i = 12; i < wav.length;) {
  const size = wav.readUInt32LE(i + 4);
  if (wav.toString('ascii', i, i+4) === 'data') { sound = wav.subarray(i+8,i+8+size); break; }
  i += 8 + size + size % 2;
}
assert(sound);
const pcm = Buffer.alloc(Math.floor(sound.length / 6) * 4);
for (let i = 0, j = 0; i + 6 <= sound.length; i += 6, j += 4) {
  pcm.writeInt16LE(Math.trunc((2*sound.readInt16LE(i) + sound.readInt16LE(i+2))/3), j);
  pcm.writeInt16LE(Math.trunc((sound.readInt16LE(i+2) + 2*sound.readInt16LE(i+4))/3), j+2);
}
const executable = process.env.HORISUB_TEST_NATIVE_EXECUTABLE;
const child = spawn(executable || process.execPath, executable ? [] : ['native/host.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const closed = once(child, 'exit');
const waiting = new Map();
let buffer = Buffer.alloc(0), sequence = 0;
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer,chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const end = 4 + buffer.readUInt32LE(0);
    const answer = JSON.parse(buffer.slice(4, end));
    buffer = buffer.subarray(end);
    waiting.get(answer.id)?.(answer);
  }
});
function send(op, args = {}, notify = false) {
  const id = ++sequence;
  const data = Buffer.from(JSON.stringify({ id, op, args }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  child.stdin.write(Buffer.concat([header,data]));
  if (notify) return;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(op + ' timed out')), 75_000);
    waiting.set(id, (answer) => {
      clearTimeout(timeout);
      waiting.delete(id);
      if (answer.code) reject(new Error(op + ' ' + answer.code));
      else resolve(answer.value);
    });
  });
}

try {
  const info = await send('hello');
  assert.equal(info.protocol, 1);
  console.log('Native', info.platform, info.engine);
  for (const model of [nativeModel, translator]) assert((await send('status',{model,verify:true})).ready);
  const session = 'native-test';
  console.log('ASR backend', await send('start',{ session, model:nativeModel, backend:process.env.HORISUB_TEST_BACKEND || 'cpu' }));
  for (let i = 0, seq = 0; i < pcm.length; i += 12_000, seq++) {
    send('audio',{session,job:1,seq,format:'pcm_s16le_16000_mono',data:pcm.subarray(i,i+12_000).toString('base64')},true);
  }
  const asr = await send('asr',{session,job:1,source});
  console.log('Transcribed', asr);
  assert.equal(asr.language, source === 'auto' ? 'en' : source);
  if (source === 'auto') assert.match(asr.text, /captions|americans/i);
  else assert(asr.text.trim());
  const targets = process.env.HORISUB_TEST_EN_TARGET ? ['zh-CN','zh-TW','en'] : ['zh-CN','zh-TW'];
  for (const target of targets) {
    const started = performance.now();
    const out = await send('translate',{session,model:translator,source:asr.language,target,text:asr.text});
    assert.match(out.text, target === 'en' ? /[a-z]{2}/i : /\p{Script=Han}/u);
    console.log(target, out.text, Math.round(performance.now() - started) + 'ms');
    if (process.env.HORISUB_TEST_TTS && target === 'zh-CN') {
      const voices = await send('voices');
      assert(voices.some(voice => /^zh-/i.test(voice.locale)));
      await send('speak', { session, text: out.text, locale: target, rate: 1, volume: .13 });
      console.log('Native speech delegate completed a real local translation');
    }
  }
  await send('stop',{session});
} finally {
  child.stdin.end();
  child.kill();
  await closed;
}
