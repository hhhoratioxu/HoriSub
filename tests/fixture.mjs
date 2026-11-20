import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { modelsRoot } from '../native/models.mjs';
import { join } from 'node:path';
import catalog from '../src/local/catalog.json' with { type:'json' };

const speechFixture = await readFile(process.env.HORISUB_TEST_WAV || new URL('../public/audio/probe.wav', import.meta.url));

function pcm(wav) {
  for (let at = 12; at + 8 <= wav.length;) {
    const length = wav.readUInt32LE(at + 4);
    if (wav.toString('ascii', at, at + 4) === 'data') return wav.subarray(at + 8, at + 8 + length);
    at += 8 + length + length % 2;
  }
  throw new Error('Test clip has no WAV data chunk');
}

function wav(chunks) {
  const audio = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + audio.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

const script = `
const readVideo = () => document.querySelector('video');
document.querySelector('#play').onclick = async () => {
  const video = readVideo();
  if (!new URL(location.href).searchParams.has('live') || video.srcObject) return video.play();
  const ac = new AudioContext();
  await ac.resume();
  const source = ac.createBufferSource();
  const destination = ac.createMediaStreamDestination();
  source.buffer = await ac.decodeAudioData(await (await fetch('/speech.wav')).arrayBuffer());
  source.loop = true;
  source.connect(destination);
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const paint = () => {
    ctx.fillStyle = '#243b41';
    ctx.fillRect(0,0,640,360);
    ctx.fillStyle = '#aaf1df';
    ctx.font = '28px system-ui';
    ctx.fillText('HoriSub · Live audio fixture',35,65);
    ctx.font = '20px monospace';
    ctx.fillText(ac.currentTime.toFixed(1) + ' s',35,110);
    requestAnimationFrame(paint);
  };
  paint();
  const stream = canvas.captureStream(12);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  window.fixtureAudio = { ac, source, destination, stream };
  video.srcObject = stream;
  source.start();
  return video.play();
};
document.querySelector('#pause').onclick = () => readVideo().pause();
document.querySelector('#theater').onclick = () => document.querySelector('main').classList.toggle('theater');
document.querySelector('#full').onclick = () => document.querySelector('#movie_player').requestFullscreen();
document.querySelector('#replace').onclick = () => {
  const next = readVideo().cloneNode(false);
  readVideo().pause();
  readVideo().replaceWith(next);
  history.pushState(null, '', '/fixture?watch=second');
  return next.play();
};
`;
const fixturePage = `<!doctype html><html lang="en">
<head><meta charset="utf-8"><title>HoriSub caption fixture</title>
<style>
  body { margin: 20px; font: 16px Helvetica, Arial; color: #eff5f4; background: #17232c; }
  main { margin: 32px auto; width: min(70vw, 850px); }
  main.theater { width: 92vw; }
  #movie_player { background: #26383d; position: relative; aspect-ratio: 16 / 9; }
  #movie_player:fullscreen { width: 100%; height: 100%; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; }
  button { margin-top: 8px; }
  p { padding: 20px; color: #adcecf; }
</style></head>
<body><main>
  <div id="movie_player">
    <p>HoriSub · controlled speech playback</p>
    <video class="html5-main-video" controls loop src="/speech.wav"></video>
  </div>
  <button id="play">Play</button><button id="pause">Pause</button><button id="theater">Theater</button>
  <button id="full">Fullscreen</button><button id="replace">Replace video</button>
</main><script>${script}</script></body></html>`;

export async function fixture() {
  const short = pcm(speechFixture);
  const speech = wav(Array.from({ length: 7 }, () => [short, Buffer.alloc(48_000)]).flat());
  const silence = wav([Buffer.alloc(48_000 * 4)]);
  let long;
  const media = path => {
    if (path === '/silence.wav') return silence;
    if (path !== '/long.wav') return speech;
    return long ??= wav(Array.from({ length: Math.ceil(3800 * 48000 / (short.length + longSilence.length)) }, () => [short, longSilence]).flat());
  };
  const longSilence = Buffer.alloc(48_000);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/embedded') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        '<title>Embedded HTML5 fixture</title><iframe src="/fixture" width="850" height="670" allow="autoplay; fullscreen" title="Video"></iframe>');
    }
    if (url.pathname === '/fixture' || url.pathname === '/other') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const track = url.searchParams.has('native') ? '<track kind="subtitles" src="/captions.vtt' +
        (url.searchParams.has('soak') ? '?continuous' : '') + '" srclang="en" default>' : '';
      const source = url.searchParams.has('soak') ? '/long.wav' : '/speech.wav';
      return res.end(url.pathname === '/fixture'
        ? fixturePage.replace('src="/speech.wav"></video>', `src="${source}">${track}</video>`)
        : '<title>No player</title>');
    }
    if (url.pathname.endsWith('.wav')) {
      const audio = media(url.pathname);
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : audio.length - 1, audio.length - 1);
        if (start > end) return res.writeHead(416, { 'Content-Range': 'bytes */' + audio.length }).end();
        return res.writeHead(206, {
          ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + audio.length,
          'Content-Length': end + 1 - start,
        }).end(audio.subarray(start, end + 1));
      }
      return res.writeHead(200, { ...headers, 'Content-Length': audio.length }).end(audio);
    }

    if (url.pathname.startsWith('/models/')) {
      const pieces = url.pathname.split('/');
      const key = pieces[2], path = pieces.slice(3).join('/');
      const pack = catalog[key];
      if (!pack || !pack.files.some(file => file.path === path)) return res.writeHead(404).end();
      const file = join(modelsRoot,pack.repo,path);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Length': info.size, 'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/octet-stream' });
      return createReadStream(file).pipe(res);
    }
    if (url.pathname === '/captions.vtt') {
      const continuous = Array.from({ length: 50 }, (_, index) => {
        const stamp = seconds => new Date(seconds * 1000).toISOString().slice(11, 23);
        return `${stamp(index * 4)} --> ${stamp(index * 4 + 3)}\n${index % 2 ? 'Hello everyone.' : 'Live captions are ready.'}\n`;
      });
      return res.writeHead(200, { 'Content-Type': 'text/vtt' }).end(
        'WEBVTT\n\n' + (url.searchParams.has('continuous') ? continuous.join('\n') :
          '00:00:00.250 --> 00:00:02.400\nThis is a test of native captions.\n\n' +
          '00:00:03.400 --> 00:00:05.400\nNative captions are available.\n'));
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
