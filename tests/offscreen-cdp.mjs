import { once } from 'node:events';
import { until } from './chrome-launch.mjs';

export async function muteMonitorForLongTest(env, verifyAudio = false) {
  const info = await (await fetch(env.chrome.debugUrl + '/json/version')).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await once(ws, 'open');
  const requests = new Map();
  let id = 0;
  ws.addEventListener('message', event => {
    const { id, result, error } = JSON.parse(event.data);
    if (!id) return;
    const action = requests.get(id);
    if (!action) return;
    requests.delete(id);
    if (error) action.reject(new Error(error.message));
    else action.resolve(result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const rid = ++id;
    const timer = setTimeout(() => { requests.delete(rid); reject(new Error('CDP ' + method + ' timed out')); }, 6000);
    requests.set(rid, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id: rid, method, params, sessionId }));
  });
  try {
    const target = await until(async () => {
      const { targetInfos } = await send('Target.getTargets', { filter: [{}] });
      return targetInfos.find(item => item.url === env.chrome.origin + '/offscreen.html');
    }, 'offscreen CDP target', 30_000);
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await until(async () => {
      const { result } = await send('Runtime.evaluate', { expression: 'AudioContext.prototype' }, sessionId);
      const { objects } = await send('Runtime.queryObjects', { prototypeObjectId: result.objectId }, sessionId);
      const { result: response, exceptionDetails } = await send('Runtime.callFunctionOn', {
        objectId: objects.objectId,
        functionDeclaration: 'async function () { const context = this.find(item => item.state === "running"); if (!context) return false; await context.setSinkId({type:"none"}); return context.sinkId.type === "none"; }',
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      if (exceptionDetails) throw new Error('AudioContext silent sink unavailable');
      return response.value;
    }, 'silent monitor output in isolated Chrome', 35_000);
    let monitorPeak;
    if (verifyAudio) {
      const { result } = await send('Runtime.evaluate', { expression: 'GainNode.prototype' }, sessionId);
      const { objects } = await send('Runtime.queryObjects', { prototypeObjectId: result.objectId }, sessionId);
      const { result: response, exceptionDetails } = await send('Runtime.callFunctionOn', {
        objectId: objects.objectId,
        functionDeclaration: `async function () {
          const monitor = this.find(node => node.context.state === 'running');
          if (!monitor || monitor.gain.value !== 1) return 0;
          const meter = monitor.context.createAnalyser();
          const signal = new Float32Array(meter.fftSize);
          monitor.connect(meter);
          try {
            for (let n = 0; n < 25; n++) {
              await new Promise(resolve => setTimeout(resolve, 90));
              meter.getFloatTimeDomainData(signal);
              const peak = signal.reduce((high, value) => Math.max(high, Math.abs(value)), 0);
              if (peak > 0.01) return peak;
            }
            return 0;
          } finally { monitor.disconnect(meter); }
        }`,
        awaitPromise:true, returnByValue:true,
      }, sessionId);
      if (exceptionDetails || !(response.value > .01)) throw new Error('Original audio did not reach the monitor gain');
      monitorPeak = response.value;
    }
    await send('Target.detachFromTarget', { sessionId });
    return monitorPeak;
  } finally { ws.close(); }
}
