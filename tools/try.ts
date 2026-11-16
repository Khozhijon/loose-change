// Runs the whole analysis on a statement in Node and prints what it finds.
//   node tools/try.ts [file.csv]      (no file: the built-in sample)
import fs from 'node:fs'
import path from 'node:path'
import {findAlerts, looseChange} from '../src/core/alerts.ts'
import {Classifier, REVIEW_BELOW} from '../src/core/classify.ts'
import {importStatement} from '../src/core/csv.ts'
import {formatDay} from '../src/core/dates.ts'
import {money} from '../src/core/money.ts'
import {findRecurring, upcoming} from '../src/core/recurring.ts'
import {sampleStatement} from '../src/core/sample.ts'
import {summarise} from '../src/core/summary.ts'
import {DIM, embed} from './embed.ts'

export async function analyse(text: string) {
  const imported = importStatement(text)
  const bank = new Float32Array(new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'bank.bin'))).buffer)
  const classifier = new Classifier(bank, DIM)
  const merchants = [...new Set(imported.txns.map(t => t.merchant))]
  const vecs = await embed(merchants)
  const at = new Map(merchants.map((m, i) => [m, vecs.subarray(i * DIM, (i + 1) * DIM)]))
  const verdicts = imported.txns.map(t => classifier.classify(t.merchant, t.raw, t.amount, at.get(t.merchant)!))
  const summary = summarise(imported.txns, verdicts)
  const recurring = findRecurring(imported.txns, verdicts, summary.endDay)
  const alerts = findAlerts(imported.txns, verdicts, recurring, summary.startDay, summary.endDay)
  return {imported, merchants, verdicts, summary, recurring, alerts, classifier, at}
}

if (import.meta.main) {
  const file = process.argv[2]
  const r = await analyse(file ? fs.readFileSync(file, 'utf8') : sampleStatement())
  console.log(`${r.imported.txns.length} lines, ${r.merchants.length} merchants, skipped ${r.imported.skipped.length}, columns ${JSON.stringify(r.imported.columns)}, flipped ${r.imported.flipped}`)
  console.log(`spent ${money(r.summary.spent)}, in ${money(r.summary.cameIn)}, moved ${money(r.summary.moved)}, per day ${money(r.summary.perDay)}`)
  console.log(r.summary.byCategory.map(c => `${c.id} ${money(c.total, true)}`).join(' | '))
  console.log('\nRECURRING')
  for (const x of r.recurring) console.log(`  ${x.active ? ' ' : 'x'} ${x.label.padEnd(30)} ${x.category.padEnd(13)} ${x.cadence.padEnd(13)} ${money(x.typical).padStart(10)} ${money(x.yearly, true).padStart(8)}/yr n=${x.count} next ${formatDay(x.nextDay)} ${x.rise ? `RISE ${money(x.rise.from)}->${money(x.rise.to)}` : ''} ${x.kind ?? ''}`)
  console.log('\nALERTS, loose change', money(looseChange(r.alerts)))
  for (const a of r.alerts) console.log(`  [${a.kind}] ${a.title} :: ${a.detail}`)
  console.log('\nUPCOMING', upcoming(r.recurring, r.summary.endDay).length)
  const unsure = new Map<string, string>()
  r.imported.txns.forEach(t => {
    const v = r.verdicts[t.id]!
    if (v.confidence < REVIEW_BELOW) unsure.set(t.merchant, `${v.category} ${v.confidence}`)
  })
  console.log('\nNEEDS A LOOK', [...unsure].map(([m, v]) => `${m} -> ${v}`).join(' | '))
  const seen = new Map<string, string>()
  r.imported.txns.forEach(t => seen.set(t.merchant, `${r.verdicts[t.id]!.category}/${r.verdicts[t.id]!.reason.how}`))
  console.log('\nALL', [...seen].map(([m, v]) => `${m}=${v}`).join(' | '))
}
