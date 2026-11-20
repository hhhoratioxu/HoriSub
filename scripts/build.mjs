import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = process.cwd();
const output = resolve(process.env.HORISUB_DIST_DIR ?? 'dist');
const asset = path => resolve(output, path);
const base = {
  configFile: false,
  base: './',
  build: {
    target: 'chrome116',
    outDir: output,
    sourcemap: false,
    minify: false,
    modulePreload: false,
  },
};

await build({
  ...base,
  build: {
    ...base.build,
    rollupOptions: {
      input: ['popup.html', 'options.html', 'offscreen.html', 'history.html', 'captions.html'].map(file => resolve(root, file)),
    },
  },
});

for (const [name, entry, format] of [
  ['background', 'src/background/main.ts', 'es'],
  ['content', 'src/content/main.ts', 'iife'],
  ['pcm-worklet', 'src/offscreen/worklet.ts', 'iife'],
]) {
  await build({
    ...base,
    publicDir: false,
    build: {
      ...base.build,
      emptyOutDir: false,
      lib: {
        entry: resolve(root, entry),
        formats: [format],
        name: 'HoriSub',
        fileName: () => name + '.js',
      },
    },
  });
}

await build({
  ...base,
  publicDir: false,
  build: {
    ...base.build,
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve(root, 'src/local/browser-worker.ts'),
      output: { entryFileNames: 'language-worker.js' },
    },
  },
});

// Copy the VAD binary and its attribution as ordinary packaged extension resources.
await mkdir(asset('runtime'), { recursive: true });
for (const extension of ['mjs', 'wasm']) {
  const file = 'ort-wasm-simd-threaded.jsep.' + extension;
  await copyFile('node_modules/@huggingface/transformers/dist/' + file, asset('runtime/' + file));
}
await mkdir(asset('audio'), { recursive: true });
await copyFile('node_modules/@echogarden/fvad-wasm/fvad.wasm', asset('audio/fvad.wasm'));
await copyFile('node_modules/@echogarden/fvad-wasm/fvad.js', asset('audio/fvad.js'));

await copyFile('node_modules/@echogarden/fvad-wasm/LICENSE', asset('audio/fvad.LICENSE.txt'));
await mkdir(asset('licenses'), { recursive: true });
for (const [source, name] of [
  ['@huggingface/transformers', 'transformers-js'],
  ['opencc-js', 'opencc-js'],
  ['@noble/hashes', 'noble-hashes'],
]) {
  await copyFile('node_modules/' + source + '/LICENSE', asset('licenses/' + name + '.txt'));
}
const manifest = JSON.parse(await readFile(asset('manifest.json'), 'utf8'));
if (manifest.background.service_worker !== 'background.js') throw new Error('Missing service worker entry');
