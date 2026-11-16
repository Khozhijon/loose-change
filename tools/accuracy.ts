// Measures the classifier on tests/labelled.ts and prints what it gets wrong.
//
//   npm run accuracy            summary and misses
//   npm run accuracy -- --json  machine-readable, used by the README numbers and the tests
import fs from 'node:fs'
import path from 'node:path'
import {Classifier, REVIEW_BELOW} from '../src/core/classify.ts'
import {cleanMerchant} from '../src/core/clean.ts'
import {HELD_OUT} from '../tests/heldout.ts'
import {LABELLED} from '../tests/labelled.ts'
import {DIM, embed} from './embed.ts'

const bankFile = path.join(import.meta.dirname, '..', 'public', 'bank.bin')
const bank = new Float32Array(new Uint8Array(fs.readFileSync(bankFile)).buffer)
const classifier = new Classifier(bank, DIM)

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0)

const merchants = LABELLED.map(row => cleanMerchant(row.raw))
const vecs = await embed(merchants)

interface Tally {
  n: number
  right: number
  sure: number
  sureRight: number
}
const blank = (): Tally => ({n: 0, right: 0, sure: 0, sureRight: 0})
const all = blank()
const seen = blank()
const unseen = blank()
const misses: string[] = []
const byHow: Record<string, number> = {}

LABELLED.forEach((row, i) => {
  const v = classifier.classify(merchants[i]!, row.raw, -2000, vecs.subarray(i * DIM, (i + 1) * DIM))
  const ok = v.category === row.category
  byHow[v.reason.how] = (byHow[v.reason.how] ?? 0) + 1
  for (const t of [all, row.seen ? seen : unseen]) {
    t.n++
    if (ok) t.right++
    if (v.confidence >= REVIEW_BELOW) {
      t.sure++
      if (ok) t.sureRight++
    }
  }
  if (!ok) {
    const why = v.reason.how === 'model' ? v.reason.neighbours.map(n => `${n.text} ${n.score}`).join('; ') : JSON.stringify(v.reason)
    misses.push(`${row.seen ? 'seen  ' : 'unseen'} ${merchants[i]!.padEnd(34)} want ${row.category.padEnd(13)} got ${v.category.padEnd(13)} conf ${v.confidence.toFixed(2)}  [${why}]`)
  }
})

// The list that was never used for tuning.
const heldMerchants = HELD_OUT.map(row => cleanMerchant(row.raw))
const heldVecs = await embed(heldMerchants)
const held = blank()
const heldMisses: string[] = []
HELD_OUT.forEach((row, i) => {
  const v = classifier.classify(heldMerchants[i]!, row.raw, -2000, heldVecs.subarray(i * DIM, (i + 1) * DIM))
  const ok = v.category === row.category
  held.n++
  if (ok) held.right++
  if (v.confidence >= REVIEW_BELOW) {
    held.sure++
    if (ok) held.sureRight++
  }
  if (!ok) heldMisses.push(`${heldMerchants[i]!.padEnd(34)} want ${row.category.padEnd(13)} got ${v.category.padEnd(13)} conf ${v.confidence.toFixed(2)}`)
})

const report = {
  rows: all.n,
  accuracy: pct(all.right, all.n),
  knownMerchants: {rows: seen.n, accuracy: pct(seen.right, seen.n)},
  neverSeenMerchants: {rows: unseen.n, accuracy: pct(unseen.right, unseen.n)},
  whenConfident: {share: pct(all.sure, all.n), accuracy: pct(all.sureRight, all.sure)},
  sentForReview: {share: pct(all.n - all.sure, all.n), accuracy: pct(all.right - all.sureRight, all.n - all.sure)},
  decidedBy: byHow,
  heldOut: {
    rows: held.n,
    accuracy: pct(held.right, held.n),
    whenConfident: {share: pct(held.sure, held.n), accuracy: pct(held.sureRight, held.sure)},
    sentForReview: {share: pct(held.n - held.sure, held.n), accuracy: pct(held.right - held.sureRight, held.n - held.sure)},
  },
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report))
else {
  console.log(JSON.stringify(report, null, 2))
  console.log(`\n${misses.length} misses:`)
  for (const m of misses) console.log(m)
  console.log(`\n${heldMisses.length} misses on the held-out list:`)
  for (const m of heldMisses) console.log(m)
}
