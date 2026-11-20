import { setup } from './chrome-core.mjs';
import { until } from './chrome-launch.mjs';
import { muteMonitorForLongTest } from './offscreen-cdp.mjs';

if (!process.env.HORISUB_CHROME_ONLINE) throw new Error('Set HORISUB_CHROME_ONLINE=1 for public site playback tests.');
const mode = process.env.HORISUB_TEST_MODE || 'native';
const env = await setup(mode);
const cases = [
  ['YouTube live', 'https://www.youtube.com/watch?v=gCNeDWCI0vo'],
  ['YouTube live France 24', 'https://www.youtube.com/watch?v=Ap-UM1O9RBU'],
  ['YouTube live DW', 'https://www.youtube.com/watch?v=LuKwFajn37U'],
  ['YouTube live Sky News', 'https://www.youtube.com/@SkyNews/live'],
  ['YouTube VOD', 'https://www.youtube.com/watch?v=aircAruvnKk'],
  ['YouTube first video', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['YouTube captions', 'https://www.youtube.com/watch?v=aircAruvnKk'],
  ['YouTube Shorts', 'https://www.youtube.com/shorts/k5Z7sFwFF7Q'],
  ['Twitch', 'https://www.twitch.tv/gamesdonequick/clip/SpicyViscousAnteaterOSsloth-K6CSwwztylETGXVW'],
  ['Twitch replay', 'https://www.twitch.tv/gamesdonequick'],
  ['Bilibili', 'https://www.bilibili.com/video/BV15uzXBvEMp/?p=3'],
  ['Bilibili BBC', 'https://www.bilibili.com/video/BV13p4y1t7pp/'],
];
const player = env.player;
try {
  console.log(JSON.stringify({ chrome: env.chrome.version.product, publicPlayback: true, mode }));
  const only = process.argv.slice(2);
  for (const [name, input] of cases) {
    if (only.length && !only.includes(name)) continue;
    let id;
    try {
      const liveVideo = name.startsWith('YouTube live');
      const load = await player.goto(input, { waitUntil:'domcontentloaded', timeout: 38_000 });
      if (load && load.status() >= 400) throw new Error('HTTP ' + load.status());
      const video = player.locator('video:visible').first();
      const reject = player.getByRole('button', { name:/Reject all|全部拒绝|拒絕所有/i }).first();
      if (await reject.isVisible().catch(() => false)) await reject.click().catch(() => {});
      const bigPlay = player.locator('.ytp-large-play-button').first();
      if (await bigPlay.isVisible().catch(() => false)) await bigPlay.click({ timeout: 4000 }).catch(() => {});
      const sitePlayback = player.locator('button[data-a-target="player-play-pause-button"], .bpx-player-ctrl-play').first();
      const probe = () => player.evaluate(() => {
        const video = [...document.querySelectorAll('video')].find(item => item.offsetWidth > 80 && !item.paused)
          ?? [...document.querySelectorAll('video')].find(item => item.offsetWidth > 80);
        const cc = document.querySelector('.ytp-subtitles-button');
        const failure = document.querySelector('.ytp-error-content-wrap-reason')?.textContent?.trim();
        return { video: !!video, ready: video?.readyState, time: video?.currentTime, error: failure,
          muted: video?.muted, paused: video?.paused, cc: cc ? { disabled: cc.hasAttribute('disabled') || cc.getAttribute('aria-disabled') === 'true',
            hidden: getComputedStyle(cc).display === 'none', active: cc.getAttribute('aria-pressed') === 'true' } : undefined,
          tracks: video?.textTracks?.length ?? 0, seekable: video?.seekable?.length,
          ad: document.querySelector('#movie_player')?.classList.contains('ad-showing') };
      });
      const first = await until(async () => {
        const info = await probe();
        if (info.error) throw Object.assign(new Error(info.error), { permanent:true });
        if (!info.video) return false;
        if (info.paused) {
          if (await sitePlayback.isVisible().catch(() => false)) await sitePlayback.click({ timeout: 1350 }).catch(() => {});
          else await video.click({ timeout: 1350 }).catch(() => {});
        }
        return info.ready >= 2 && info.time > .16 && !info.paused && !info.ad && info;
      }, 'public player playing', 24_000);
      console.log(JSON.stringify({ name, stage: 'media-playing', url: player.url(), ...first }));
      if (first.muted) {
        const mute = player.locator('.ytp-mute-button').first();
        if (await mute.isVisible().catch(() => false)) await mute.click({ timeout: 4000 });
      }
      await env.options.selectOption('#source', 'en');
      if (name === 'YouTube captions') {
        await env.options.selectOption('#captionSource','native');
        await env.options.locator('#save').click();
        const button = player.locator('.ytp-subtitles-button');
        if (await button.isVisible() && await button.getAttribute('aria-pressed') !== 'true') {
          await button.click({ timeout: 4000 }).catch(() => {});
        }
      } else {
        await env.options.selectOption('#captionSource','audio');
        await env.options.locator('#save').click();
        if (first.cc?.active && !first.cc.hidden) {
          await player.locator('.ytp-subtitles-button').click({ timeout: 4000 }).catch(() => {});
        }
      }
      const atCapture = await probe();
      const hold = !liveVideo && !name.startsWith('Bilibili') && !name.startsWith('Twitch');
      await video.evaluate((element, hold) => {
        element.muted = false;
        element.volume = .24;
        if (hold) {
          element.pause();
          if (Number.isFinite(element.duration)) element.currentTime = Math.min(element.duration - .1, 1);
        }
      }, hold);
      id = await env.start();
      await muteMonitorForLongTest(env);
      await env.popup.close();
      await player.bringToFront();
      if (hold) {
        await until(async () => {
          const { live, issue } = await env.status(id);
          if (issue) throw Object.assign(new Error(issue.text), { permanent: true });
          return live?.phase === 'paused' && live?.backend;
        }, 'local models initialized while paused', 115_000);
      }
      if (await video.evaluate(element => element.paused)) {
        if (await sitePlayback.isVisible().catch(() => false)) await sitePlayback.click({ timeout: 3000 }).catch(() => {});
        await video.evaluate(element => Promise.race([element.play(), new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Player had not resumed in 15 seconds')), 15_000);
        })]));
      }
      const caption = await env.getCaption(id, 105_000, ({ original }) => !/^[\[(].+[\])]$/.test(original.trim()));
      const {live} = await env.status(id);
      console.log(JSON.stringify({ name, url: player.url(), first, ccAtCapture: atCapture.cc, tracksAtCapture: atCapture.tracks, backend: live.backend,
        caption, source: live.actualSource, timing: live.diagnostics.timings }));
      if (liveVideo) {
        const seekLive = towardsEnd => video.evaluate((element, end) => {
          const range = element.seekable;
          if (!range.length) return false;
          const edge = range.end(range.length - 1);
          if (edge - range.start(range.length - 1) < 38) return false;
          element.currentTime = edge - (end ? 1 : 32);
          return true;
        }, towardsEnd);
        let revision = live.playbackRevision;
        for (const edge of [false, true]) {
          if (!(await seekLive(edge))) break;
          revision = await until(async () => {
            const value = (await env.status(id)).live?.playbackRevision;
            return value > revision && value;
          }, 'live media timeline updated', 15_000);
          const next = await env.getCaption(id, 45_000);
          console.log(JSON.stringify({ name, stage: edge ? 'returned-to-live-edge' : 'live-rewind', revision, next }));
        }
      }
    } catch (error) {
      const note = await player.evaluate(() => ({
        title: document.title, error: document.querySelector('.ytp-error-content-wrap-reason')?.textContent?.trim(),
        videos: document.querySelectorAll('video').length,
      })).catch(() => ({}));
      const status = id === undefined ? undefined : (await env.status(id).catch(() => ({}))).live;
      console.log(JSON.stringify({ name, url: player.url(), error: error.message, cause:error.cause?.message, note,
        status: status && { phase: status.phase, source: status.actualSource, backend: status.backend, diagnostics: status.diagnostics } }));
    } finally {
      if (id !== undefined) await env.message('stop',{tabId:id}).catch(() => {});
    }
  }
} finally { await env.close(); }
