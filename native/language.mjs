import { parentPort, workerData } from 'node:worker_threads';
import { sep } from 'node:path';
import { LocalInference, configureInference } from '../src/local/infer.mjs';
import { catalog } from './models.mjs';

configureInference({ root: workerData.root + sep });
const inference = new LocalInference(catalog, 'cpu');
let queue = Promise.resolve();
parentPort.on('message', ({ id, args, op }) => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id, value: await (op === 'warm' ? inference.prepare(args.model) : inference.translate(args)) }); }
    catch (error) {
      const code = ['inference', 'language'].includes(error.code) ? error.code : 'model_load';
      parentPort.postMessage({ id, code });
    }
  });
});
