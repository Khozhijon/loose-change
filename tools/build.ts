// Builds the static site into public/: bundles the app and the model worker, copies the
// runtime the model needs, and writes the sample statement as a file people can download.
//
//   npm run build
import fs from 'node:fs'
import path from 'node:path'
import {build} from 'esbuild'
import {sampleStatement} from '../src/core/sample.ts'

const root = path.join(import.meta.dirname, '..')
const out = path.join(root, 'public')
const watch = process.argv.includes('--dev')

await build({
  entryPoints: {app: path.join(root, 'src/web/main.ts'), worker: path.join(root, 'src/web/worker.ts')},
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir: out,
  minify: !watch,
  sourcemap: watch ? 'linked' : false,
  logLevel: 'warning',
  legalComments: 'none',
  // The model runtime picks its files at run time; nothing Node-only is needed in the browser.
  external: ['node:*', 'fs', 'path', 'url', 'sharp', 'onnxruntime-node'],
})

// The WebAssembly runtime the model runs on, served from our own address so no CDN is contacted.
const dist = path.join(root, 'node_modules/@huggingface/transformers/dist')
fs.mkdirSync(path.join(out, 'ort'), {recursive: true})
for (const file of fs.readdirSync(dist).filter(f => f.startsWith('ort-wasm'))) fs.copyFileSync(path.join(dist, file), path.join(out, 'ort', file))

fs.writeFileSync(path.join(out, 'sample-statement.csv'), sampleStatement())
for (const needed of ['bank.bin', 'bank.json', 'models/all-MiniLM-L6-v2/onnx/model_quantized.onnx']) {
  if (!fs.existsSync(path.join(out, needed))) throw new Error(`public/${needed} is missing: run "npm run bank" (and see README for the model files)`)
}
const size = (f: string) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`
console.log(`built: app.js ${size('app.js')}, worker.js ${size('worker.js')}, sample-statement.csv ${size('sample-statement.csv')}`)
