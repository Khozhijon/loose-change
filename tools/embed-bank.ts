// Computes the embedding of every labelled example once and writes them to public/bank.bin,
// so the browser only has to embed the user's own merchants.
//
//   npm run bank
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {BANK} from '../src/core/bank.ts'
import {DIM, embed} from './embed.ts'

const out = path.join(import.meta.dirname, '..', 'public')
const texts = BANK.map(e => e.text)
const started = Date.now()
const vecs = await embed(texts)
fs.writeFileSync(path.join(out, 'bank.bin'), Buffer.from(vecs.buffer))
// The app checks this fingerprint so vectors can never be paired with the wrong examples.
const fingerprint = createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 16)
fs.writeFileSync(path.join(out, 'bank.json'), JSON.stringify({count: texts.length, dim: DIM, fingerprint}) + '\n')
console.log(`${texts.length} examples embedded in ${Date.now() - started} ms -> public/bank.bin (${(vecs.byteLength / 1024).toFixed(0)} KB), fingerprint ${fingerprint}`)
