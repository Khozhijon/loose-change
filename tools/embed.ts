// Runs the same sentence-embedding model in Node that the app runs in the browser,
// from the copy in public/models, so tools and tests need no network.
import path from 'node:path'
import {env, pipeline} from '@huggingface/transformers'

export const DIM = 384
export const MODEL = 'all-MiniLM-L6-v2'

env.allowRemoteModels = false
env.localModelPath = path.join(import.meta.dirname, '..', 'public', 'models') + path.sep

let extractor: any = null

/** Returns one unit-length vector per text, packed end to end. */
export async function embed(texts: string[]): Promise<Float32Array> {
  extractor ??= await (pipeline as any)('feature-extraction', MODEL, {dtype: 'q8'})
  const out = new Float32Array(texts.length * DIM)
  for (let at = 0; at < texts.length; at += 32) {
    const batch = texts.slice(at, at + 32)
    const tensor = await (extractor as any)(batch, {pooling: 'mean', normalize: true})
    out.set(tensor.data as Float32Array, at * DIM)
  }
  return out
}
