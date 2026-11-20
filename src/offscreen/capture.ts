import { ServiceError } from '../shared/errors';

interface WorkletFrame {
  pcm: ArrayBuffer;
  rms: number;
  sequence: number;
  contextTime: number;
}

export class TabAudio {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private monitor?: GainNode;
  private worklet?: AudioWorkletNode;
  private closed = false;

  async start(streamId: string, onFrame: (frame: WorkletFrame, at: number) => void, onEnd: () => void) {
    const constraints = {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    } as unknown as MediaTrackConstraints;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }).catch((error: unknown) => {
      const name = error instanceof DOMException ? error.name : 'UnknownError';
      throw new ServiceError('capture', 'Chrome 未能取得标签页音轨（' + name + '）。请从视频标签页重新开始。');
    });
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    navigator.mediaDevices.addEventListener('devicechange', this.deviceChanged);
    for (const track of stream.getTracks()) track.onended = onEnd;
    const context = this.context = new AudioContext({ latencyHint: 'interactive' });
    const source = this.source = context.createMediaStreamSource(stream);
    const monitor = this.monitor = context.createGain();
    source.connect(monitor);
    monitor.connect(context.destination);

    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([context.resume(), context.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'))]),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new ServiceError('capture', 'Chrome 未能恢复标签页音频。请重新开始。')), 9000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (this.closed) return;
    if (context.state !== 'running') throw new ServiceError('capture');
    const worklet = this.worklet = new AudioWorkletNode(context, 'horisub-pcm', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    worklet.onprocessorerror = onEnd;
    worklet.port.onmessage = ({ data }: MessageEvent<WorkletFrame>) => {
      try {
        // currentTime comes from the render quantum in which this frame ended.
        const at = Date.now() - Math.max(0, (context.currentTime - data.contextTime) * 1000);
        onFrame(data, at);
      } finally {
        worklet.port.postMessage(1);
      }
    };
    source.connect(worklet);
    worklet.connect(context.destination);
    worklet.port.postMessage(8);
  }

  private readonly deviceChanged = () => {
    if (this.context?.state === 'suspended') void this.context.resume().catch(() => {});
  };

  duck(value: boolean) {
    if (this.monitor && this.context?.state === 'running') {
      this.monitor.gain.setTargetAtTime(value ? 0.32 : 1, this.context.currentTime, 0.045);
    }
  }

  async close() {
    this.closed = true;
    navigator.mediaDevices.removeEventListener('devicechange', this.deviceChanged);
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
      this.worklet.onprocessorerror = null;
      this.worklet.disconnect();
      this.worklet = undefined;
    }
    // Stopping tracks returns playback to the tab; it also stops the worklet input immediately.
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = undefined;
    this.source?.disconnect();
    this.source = undefined;
    this.monitor?.disconnect();
    this.monitor = undefined;
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }
}
