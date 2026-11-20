interface DocumentPiP { requestWindow(options: { width: number; height: number }): Promise<Window> }

export class CaptionPiP {
  private popup?: Window;

  async open(video: HTMLVideoElement, lines: () => { original: string; translation: string }) {
    const api = (window as Window & { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture;
    if (!api || window !== window.top || video.mediaKeys) return false;
    this.close();
    const pip = await api.requestWindow({ width: 560, height: 360 }).catch(() => undefined);
    if (!pip || !video.isConnected) { pip?.close(); return false; }
    this.popup = pip;
    const doc = pip.document;
    doc.title = 'HoriSub 画中画';
    const style = doc.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; } body { margin: 0; background: #0b1217; color: #fff; font: 15px system-ui; }
      main { height: 100vh; display: grid; grid-template-rows: minmax(0,1fr) 36px; }
      section { position: relative; min-height: 0; }
      canvas { width: 100%; height: 100%; object-fit: contain; }
      aside { position: absolute; bottom: 8%; width: 90%; left: 5%; text-align: center; pointer-events: none; }
      p { margin: 2px 0; } span { background: #000c; border-radius: 4px; padding: 2px 7px; overflow-wrap: anywhere; }
      span:empty { display: none; } p:last-child { font-size: 22px; font-weight: 600; }
      nav { padding: 3px 10px; display: flex; gap: 7px; align-items: center; }
      button { color: #effcf9; background: #1c3337; border: 1px solid #476b6f; border-radius: 6px; padding: 4px 8px; }
      button:focus-visible { outline: 2px solid #81ebd5; }
    `;
    const main = doc.createElement('main');
    const stage = doc.createElement('section');
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) { this.close(); return false; }
    const captions = doc.createElement('aside');
    const makeLine = () => {
      const line = doc.createElement('p');
      const span = doc.createElement('span');
      span.dir = 'auto';
      line.append(span);
      captions.append(line);
      return span;
    };
    const original = makeLine(), translation = makeLine();
    const controls = doc.createElement('nav');
    controls.setAttribute('aria-label', '视频控制');
    const control = (label: string, click: () => void) => {
      const item = doc.createElement('button');
      item.textContent = label;
      item.onclick = click;
      controls.append(item);
      return item;
    };
    const play = control('暂停', () => {
      if (video.paused) void video.play().catch(() => {});
      else video.pause();
    });
    const seek = (amount: number) => {
      if (video.seekable.length) video.currentTime = Math.max(video.seekable.start(0),
        Math.min(video.seekable.end(video.seekable.length - 1), video.currentTime + amount));
    };
    control('后退 5 秒', () => seek(-5));
    control('前进 5 秒', () => seek(5));
    control('关闭', () => this.close());
    stage.append(canvas, captions);
    main.append(stage, controls);
    doc.head.append(style);
    doc.body.append(main);
    let at = 0, frame = 0;
    const update = (now: number) => {
      if (!video.isConnected || video.mediaKeys) { this.close(); return; }
      if (now - at >= 33) {
        at = now;
        if (video.readyState >= 2 && video.videoWidth) {
          const width = Math.min(960, video.videoWidth);
          const height = Math.round(width * video.videoHeight / video.videoWidth);
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
          try { ctx.drawImage(video, 0, 0, width, height); }
          catch { canvas.style.display = 'none'; }
        }
        const value = lines();
        if (original.textContent !== value.original) original.textContent = value.original;
        if (translation.textContent !== value.translation) translation.textContent = value.translation;
        play.textContent = video.paused ? '继续' : '暂停';
      }
      frame = pip.requestAnimationFrame(update);
    };
    frame = pip.requestAnimationFrame(update);
    pip.addEventListener('pagehide', () => {
      pip.cancelAnimationFrame(frame);
      if (this.popup === pip) this.popup = undefined;
    }, { once: true });
    return true;
  }

  close() {
    this.popup?.close();
    this.popup = undefined;
  }
}
