import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = tests
  ? [
      {
        ...common,
        entryPoints: readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`),
        outdir: 'dist-test',
        platform: 'node',
        format: 'esm',
        outExtension: { '.js': '.mjs' },
        target: 'node20',
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['vscode'],
      },
      {
        ...common,
        entryPoints: {
          gallery: 'src/webview/gallery/main.ts',
          thumbWorker: 'src/webview/gallery/thumbWorker.ts',
          analysisWorker: 'src/webview/gallery/analysisWorker.ts',
          patchWorker: 'src/webview/detail/editor/patchWorker.ts',
        },
        outdir: 'dist/webview',
        platform: 'browser',
        format: 'iife',
        target: 'chrome120',
        loader: { '.css': 'css' },
      },
      {
        ...common,
        // onnxruntime-web's ESM bundle uses import.meta.url, so this worker is started as a module worker.
        entryPoints: { tagWorker: 'src/webview/tagger/tagWorker.ts' },
        outdir: 'dist/webview',
        platform: 'browser',
        format: 'esm',
        target: 'chrome120',
      },
    ];

if (tests) rmSync('dist-test', { recursive: true, force: true });
else {
  // Loaded at runtime from env.wasm.wasmPaths (the webview URI of dist/webview).
  mkdirSync('dist/webview', { recursive: true });
  copyFileSync(
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    'dist/webview/ort-wasm-simd-threaded.jsep.wasm',
  );
}

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
