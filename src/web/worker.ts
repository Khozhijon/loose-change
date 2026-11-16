/// <reference lib="webworker" />
// Runs the sentence-embedding model off the main thread, from files served with the app.
// Nothing here talks to any other server: remote model loading is switched off.
import {env, pipeline} from '@huggingface/transformers'

declare const self: DedicatedWorkerGlobalScope

export type ToWorker = {type: 'load'} | {type: 'embed'; id: number; texts: string[]}
export type FromWorker =
  | {type: 'progress'; loaded: number; total: number}
  | {type: 'ready'; ms: number}
  | {type: 'failed'; message: string}
  | {type: 'vectors'; id: number; data: Float32Array; ms: number}
  | {type: 'embed-failed'; id: number; message: string}

const here = new URL('./', self.location.href).href
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = `${here}models/`
const wasm = env.backends.onnx.wasm!
wasm.wasmPaths = `${here}ort/`
// One thread: more would need cross-origin isolation headers that plain static hosts do not send.
wasm.numThreads = 1

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer)

let extractor: any = null
let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= (async () => {
    const started = performance.now()
    const sizes = new Map<string, {loaded: number; total: number}>()
    extractor = await (pipeline as any)('feature-extraction', 'all-MiniLM-L6-v2', {
      dtype: 'q8',
      progress_callback: (p: any) => {
        if (p.status !== 'progress' || !p.file) return
        sizes.set(p.file, {loaded: p.loaded ?? 0, total: p.total ?? 0})
        let loaded = 0
        let total = 0
        for (const s of sizes.values()) {
          loaded += s.loaded
          total += s.total
        }
        post({type: 'progress', loaded, total})
      },
    })
    // A first run compiles the model; do it now so the first real request is quick.
    await extractor(['warm up'], {pooling: 'mean', normalize: true})
    post({type: 'ready', ms: Math.round(performance.now() - started)})
  })()
  return loading
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  if (message.type === 'load') {
    load().catch(err => post({type: 'failed', message: String(err?.message ?? err)}))
    return
  }
  try {
    await load()
    const started = performance.now()
    const tensor = await extractor(message.texts, {pooling: 'mean', normalize: true})
    const data = new Float32Array(tensor.data as Float32Array)
    post({type: 'vectors', id: message.id, data, ms: Math.round(performance.now() - started)}, [data.buffer])
  } catch (err: any) {
    post({type: 'embed-failed', id: message.id, message: String(err?.message ?? err)})
  }
}
