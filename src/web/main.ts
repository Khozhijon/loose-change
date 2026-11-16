import {findAlerts, looseChange} from '../core/alerts.ts'
import {answer, parseQuestion, targetForCategory, targetWithoutModel, type Answer, type Target} from '../core/ask.ts'
import {BANK} from '../core/bank.ts'
import {CATEGORIES, category} from '../core/categories.ts'
import {byRule, Classifier, REVIEW_BELOW} from '../core/classify.ts'
import {importStatement, toCsv} from '../core/csv.ts'
import {formatDay, isoDay, monthLabel} from '../core/dates.ts'
import {money, plural} from '../core/money.ts'
import {findRecurring, upcoming} from '../core/recurring.ts'
import {sampleStatement} from '../core/sample.ts'
import {summarise, type Summary} from '../core/summary.ts'
import type {Alert, CategoryId, ImportResult, Recurring, Txn, Verdict} from '../core/types.ts'
import type {FromWorker, ToWorker} from './worker.ts'

const DIM = 384
const TAUGHT_KEY = 'loose-change:taught'
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** Statement text is untrusted: everything shown goes through this. */
function e(text: string | number): string {
  return String(text).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]!)
}

// ---------------------------------------------------------------- the model

type ModelState = 'idle' | 'loading' | 'ready' | 'failed'
let modelState: ModelState = 'idle'
let modelNote = ''
let worker: Worker | null = null
let nextJob = 1
const jobs = new Map<number, {resolve: (v: Float32Array) => void; reject: (err: Error) => void}>()
const vectors = new Map<string, Float32Array>()
let classifier = new Classifier(null, DIM)
let bankReady: Promise<void> | null = null

function startModel(): void {
  if (worker) return
  modelState = 'loading'
  modelNote = 'Loading the model onto this device'
  paintStatus()
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'})
  } catch (err) {
    modelState = 'failed'
    modelNote = 'The model could not start in this browser. Known merchants and rules still work.'
    paintStatus()
    return
  }
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const m = event.data
    if (m.type === 'progress') {
      if (modelState === 'loading' && m.total > 0) {
        modelNote = `Loading the model onto this device: ${Math.min(99, Math.round((m.loaded / m.total) * 100))}%`
        paintStatus()
      }
    } else if (m.type === 'ready') {
      modelState = 'ready'
      modelNote = `Model ready on this device (${(m.ms / 1000).toFixed(1)} s)`
      paintStatus()
    } else if (m.type === 'failed') {
      modelState = 'failed'
      modelNote = 'The model could not load. Known merchants and rules still work.'
      console.error('model failed:', m.message)
      for (const job of jobs.values()) job.reject(new Error(m.message))
      jobs.clear()
      paintStatus()
    } else if (m.type === 'vectors') {
      jobs.get(m.id)?.resolve(m.data)
      jobs.delete(m.id)
    } else {
      jobs.get(m.id)?.reject(new Error(m.message))
      jobs.delete(m.id)
    }
  }
  worker.onerror = event => {
    modelState = 'failed'
    modelNote = 'The model could not load. Known merchants and rules still work.'
    console.error('model worker error:', event.message)
    for (const job of jobs.values()) job.reject(new Error(event.message))
    jobs.clear()
    paintStatus()
  }
  worker.postMessage({type: 'load'} satisfies ToWorker)
  bankReady = loadBank()
}

/** The labelled examples' vectors, checked against the list they were made from. */
async function loadBank(): Promise<void> {
  try {
    const [meta, bin] = await Promise.all([fetch('bank.json').then(r => r.json()), fetch('bank.bin').then(r => r.arrayBuffer())])
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BANK.map(b => b.text).join('\n')))
    const fingerprint = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
    if (meta.count !== BANK.length || meta.dim !== DIM || meta.fingerprint !== fingerprint) throw new Error('example vectors are out of date; run npm run bank')
    const fresh = new Classifier(new Float32Array(bin), DIM)
    fresh.taught = classifier.taught
    classifier = fresh
  } catch (err) {
    console.error('example vectors unavailable:', err)
    modelState = 'failed'
    modelNote = 'The model files could not be read. Known merchants and rules still work.'
    paintStatus()
  }
}

function embed(texts: string[]): Promise<Float32Array> {
  startModel()
  if (modelState === 'failed' || !worker) return Promise.reject(new Error('model unavailable'))
  const id = nextJob++
  return new Promise((resolve, reject) => {
    jobs.set(id, {resolve, reject})
    worker!.postMessage({type: 'embed', id, texts} satisfies ToWorker)
  })
}

// ---------------------------------------------------------------- state

interface State {
  fileName: string
  imported: ImportResult
  verdicts: Verdict[]
  summary: Summary
  recurring: Recurring[]
  alerts: Alert[]
  /** Lines picked out by "See the lines" on an alert, an answer or a regular charge. */
  picked: {ids: Set<number>; label: string} | null
  onlyCategory: CategoryId | ''
  search: string
  shown: number
  /** Regular charges the user says they would drop. */
  dropped: Set<string>
  reply: {question: string; answer: Answer; understood: string} | null
  /** Merchants still waiting for the model. */
  waiting: number
}
let state: State | null = null

function loadTaught(): {text: string; category: CategoryId}[] {
  try {
    const list = JSON.parse(localStorage.getItem(TAUGHT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter(x => typeof x?.text === 'string' && CATEGORIES.some(c => c.id === x.category)) : []
  } catch {
    return []
  }
}

function saveTaught(): void {
  try {
    localStorage.setItem(TAUGHT_KEY, JSON.stringify(classifier.taught.map(({text, category}) => ({text, category}))))
  } catch {
    // Private windows may refuse storage; teaching still works until the tab closes.
  }
}

function classifyAll(s: State): void {
  s.verdicts = s.imported.txns.map(t => classifier.classify(t.merchant, t.raw, t.amount, vectors.get(t.merchant) ?? null))
  s.summary = summarise(s.imported.txns, s.verdicts)
  s.recurring = findRecurring(s.imported.txns, s.verdicts, s.summary.endDay)
  s.alerts = findAlerts(s.imported.txns, s.verdicts, s.recurring, s.summary.startDay, s.summary.endDay)
}

function open(text: string, fileName: string): void {
  const imported = importStatement(text)
  const error = $('start-error')
  if (!imported.txns.length) {
    error.hidden = false
    error.textContent = `That file could not be read as a statement. ${imported.skipped[0]?.why ?? ''} Export your transactions as CSV from your bank's website and try again.`
    return
  }
  error.hidden = true
  for (const t of loadTaught()) if (!classifier.taught.some(x => x.text === t.text)) classifier.teach(t.text, t.category, null)
  state = {
    fileName, imported, verdicts: [], summary: summarise([], []), recurring: [], alerts: [],
    picked: null, onlyCategory: '', search: '', shown: 60, dropped: new Set(), reply: null, waiting: 0,
  }
  classifyAll(state)
  $('start').hidden = true
  $('app').hidden = false
  mountOnce()
  paint()
  window.scrollTo({top: 0})
  void readUnfamiliar(state)
}

/** Sends the merchants no rule could place to the model, a few at a time, repainting as answers arrive. */
async function readUnfamiliar(s: State): Promise<void> {
  const taughtWithoutVec = classifier.taught.filter(t => !t.vec).map(t => t.text)
  const unknown = [...new Set(s.imported.txns.filter(t => !vectors.has(t.merchant) && !byRule(t.merchant, t.raw, t.amount)).map(t => t.merchant))]
  const todo = [...new Set([...unknown, ...taughtWithoutVec])].filter(m => !vectors.has(m))
  if (!todo.length) return
  s.waiting = todo.length
  paintStatus()
  try {
    await bankReady
    for (let at = 0; at < todo.length; at += 12) {
      const batch = todo.slice(at, at + 12)
      const data = await embed(batch)
      batch.forEach((m, i) => vectors.set(m, data.slice(i * DIM, (i + 1) * DIM)))
      for (const t of classifier.taught) if (!t.vec && vectors.has(t.text)) t.vec = vectors.get(t.text)!
      if (state !== s) return
      s.waiting = todo.length - at - batch.length
      classifyAll(s)
      paint()
    }
  } catch (err) {
    console.error(err)
    if (state === s) {
      s.waiting = 0
      paintStatus()
    }
  }
}

// ---------------------------------------------------------------- painting

function paintStatus(): void {
  const el = $('model-status')
  if (!el) return
  let text = modelNote
  if (state?.waiting && modelState !== 'failed') text = `Reading ${plural(state.waiting, 'unfamiliar merchant')} with the on-device model`
  else if (state && modelState === 'ready') {
    const merchants = new Set(state.imported.txns.map(t => t.merchant)).size
    text = `All ${merchants} merchants read on this device`
  }
  el.textContent = text
  el.dataset.state = state?.waiting ? 'busy' : modelState
}

function chip(id: CategoryId): string {
  return `<span class="chip c-${id}">${e(category(id).label)}</span>`
}

function paint(): void {
  if (!state) return
  const s = state
  const {summary} = s
  const txns = s.imported.txns
  $('file-line').innerHTML = `<b>${e(s.fileName)}</b> · ${formatDay(summary.startDay)} to ${formatDay(summary.endDay)} · ${plural(txns.length, 'line')}${s.imported.skipped.length ? ` · <span class="warn">${plural(s.imported.skipped.length, 'line')} could not be read</span>` : ''}${s.imported.flipped ? ' · <span title="This file listed purchases as positive numbers, so the signs were turned round.">signs turned round</span>' : ''}`

  // Headline.
  const loose = looseChange(s.alerts)
  const how = {known: 0, model: 0, rule: 0, taught: 0}
  for (const v of s.verdicts) how[v.reason.how]++
  const asked = new Set(txns.filter(t => t.amount < 0 && s.verdicts[t.id]!.confidence < REVIEW_BELOW).map(t => t.merchant)).size
  const regularYear = s.recurring.filter(r => r.active && r.category !== 'transfers').reduce((sum, r) => sum + r.yearly, 0)
  $('headline').innerHTML = `
    <div class="receipt">
      <p class="eyebrow">What your statement says</p>
      ${loose > 0
        ? `<h1><span class="big">${money(loose, true)}</span> <span class="big-after">a year of loose change</span></h1>
           <p class="sub">That is what the bank fees, price rises and double charges below add up to if nothing changes.</p>`
        : `<h1><span class="big-after">No fees, price rises or double charges found.</span></h1><p class="sub">Your regular charges are still worth a look below.</p>`}
      <dl class="tiles">
        <div><dt>Money out</dt><dd>${money(summary.spent, true)}</dd><small>${money(summary.perDay)} a day</small></div>
        <div><dt>Money in</dt><dd>${money(summary.cameIn, true)}</dd><small>${summary.cameIn >= summary.spent ? `${money(summary.cameIn - summary.spent, true)} more than you spent` : `${money(summary.spent - summary.cameIn, true)} less than you spent`}</small></div>
        <div><dt>Regular charges</dt><dd>${money(regularYear, true)}</dd><small>a year, across ${plural(s.recurring.filter(r => r.active && r.category !== 'transfers').length, 'charge')}</small></div>
        <div><dt>Moved, not spent</dt><dd>${money(summary.moved, true)}</dd><small>to savings, cards or people</small></div>
      </dl>
      <p class="sorted">How the ${plural(txns.length, 'line')} were sorted: <b>${how.known}</b> matched a known merchant, <b>${how.model}</b> were read by the on-device model, <b>${how.rule}</b> followed a plain rule${how.taught ? `, <b>${how.taught}</b> you taught it` : ''}.${asked ? ` It was unsure about ${plural(asked, 'merchant')} and asks you below.` : ''}</p>
    </div>`

  // Alerts.
  const tag = (a: Alert): string => {
    if (a.kind === 'duplicate') return `<b>${money(a.amount)}</b><span>to ask back</span>`
    if (a.kind === 'price_rise') return `<b>+${money(a.yearly ?? 0, true)}</b><span>a year</span>`
    if (a.kind === 'fee') return `<b>${money(a.yearly ?? 0, true)}</b><span>a year at this rate</span>`
    if (a.kind === 'overlap') return `<b>${money(a.yearly ?? 0, true)}</b><span>a year you could free</span>`
    if (a.kind === 'unusual') return `<b>${money(a.amount)}</b><span>one charge</span>`
    return `<b>${money(a.yearly ?? 0, true)}</b><span>a year</span>`
  }
  const mark: Record<Alert['kind'], string> = {duplicate: '2×', price_rise: '↑', fee: '%', overlap: '≡', new_recurring: 'new', trial: '$1', unusual: '!'}
  $('alerts').innerHTML = `
    <h2 id="alerts-h">Worth a look <span class="count">${s.alerts.length}</span></h2>
    ${s.alerts.length ? `<ul class="alerts">${s.alerts.map((a, i) => `
      <li class="alert k-${a.kind}">
        <span class="mark" aria-hidden="true">${mark[a.kind]}</span>
        <div class="alert-body"><h3>${e(a.title)}</h3><p>${e(a.detail)}</p></div>
        <div class="alert-side">${tag(a)}<button type="button" class="link" data-act="alert-lines" data-i="${i}">See the ${plural(a.txnIds.length, 'line')}</button></div>
      </li>`).join('')}</ul>` : '<p class="empty">Nothing stood out. No double charges, price rises or bank fees in this statement.</p>'}`

  // Regular charges.
  const soon = upcoming(s.recurring, summary.endDay)
  const soonTotal = soon.reduce((sum, u) => sum + u.amount, 0)
  const back = s.recurring.filter(r => s.dropped.has(r.merchant)).reduce((sum, r) => sum + r.yearly, 0)
  $('regular').innerHTML = `
    <h2 id="regular-h">Regular charges <span class="count">${s.recurring.length}</span></h2>
    ${s.recurring.length ? `
    <p class="section-note">Found by the rhythm of the dates, not by a list of names. In the 30 days after this statement expect <b>${money(soonTotal, true)}</b> across ${plural(soon.length, 'charge')}. Tick anything you would drop.</p>
    <div class="table-wrap"><table class="regular">
      <thead><tr><th scope="col"><span class="sr">Drop</span></th><th scope="col">Who</th><th scope="col">How often</th><th scope="col" class="num">Each time</th><th scope="col" class="num">A year</th><th scope="col">Next</th><th scope="col"><span class="sr">Lines</span></th></tr></thead>
      <tbody>${s.recurring.map((r, i) => `
        <tr class="${r.active ? '' : 'stopped'}${s.dropped.has(r.merchant) ? ' dropped' : ''}">
          <td><input type="checkbox" data-act="drop" data-i="${i}" aria-label="I would drop ${e(r.label)}" ${s.dropped.has(r.merchant) ? 'checked' : ''} ${r.active ? '' : 'disabled'}></td>
          <th scope="row"><span class="who">${e(r.label)}</span> ${chip(r.category)}${r.kind ? ` <span class="kind">${e(r.kind)}</span>` : ''}${r.rise ? ` <span class="rise" title="Was ${money(r.rise.from)} until ${formatDay(r.rise.day)}">↑ from ${money(r.rise.from)}</span>` : ''}</th>
          <td>${e(r.cadence)}</td>
          <td class="num">${money(r.typical)}</td>
          <td class="num"><b>${money(r.yearly, true)}</b></td>
          <td>${r.active ? formatDay(r.nextDay, false) : `<span class="muted">stopped ${formatDay(r.lastDay, false)}</span>`}</td>
          <td><button type="button" class="link" data-act="regular-lines" data-i="${i}">${plural(r.count, 'line')}</button></td>
        </tr>`).join('')}</tbody>
    </table></div>
    <p class="back ${back ? 'on' : ''}" aria-live="polite">${back ? `Dropping the ${plural(s.dropped.size, 'ticked charge')} would give you back <b>${money(back, true)} a year</b>.` : 'Nothing ticked yet.'}</p>` : '<p class="empty">No charge in this statement comes round on a rhythm. A longer statement (three months or more) shows more.</p>'}`

  // Needs a look.
  const unsure = new Map<string, {label: string; count: number; total: number; verdict: Verdict}>()
  for (const t of txns) {
    const v = s.verdicts[t.id]!
    if (t.amount >= 0 || v.confidence >= REVIEW_BELOW) continue
    const u = unsure.get(t.merchant) ?? {label: t.label, count: 0, total: 0, verdict: v}
    u.count++
    u.total -= t.amount
    unsure.set(t.merchant, u)
  }
  const queue = [...unsure].sort((a, b) => b[1].total - a[1].total)
  const options = CATEGORIES.filter(c => c.id !== 'income').map(c => `<option value="${c.id}">${e(c.label)}</option>`).join('')
  $('review').hidden = !queue.length && !s.waiting
  $('review').innerHTML = `
    <h2 id="review-h">It was not sure about these <span class="count">${queue.length}</span></h2>
    <p class="section-note">The model says when it is unsure instead of guessing quietly. Tell it once and it remembers on this device, and similar names follow.</p>
    <ul class="review">${queue.slice(0, 8).map(([merchant, u], n) => {
      const guesses: CategoryId[] = []
      if (u.verdict.category !== 'other') guesses.push(u.verdict.category)
      if (u.verdict.reason.how === 'model') for (const n of u.verdict.reason.neighbours) if (!guesses.includes(n.category) && n.category !== 'income') guesses.push(n.category)
      return `
      <li>
        <div class="review-who"><b>${e(u.label)}</b><span>${plural(u.count, 'payment')}, ${money(u.total)}</span></div>
        <div class="review-pick" data-merchant="${e(merchant)}">
          ${guesses.slice(0, 3).map(g => `<button type="button" class="guess c-${g}" data-act="teach" data-category="${g}">${e(category(g).label)}</button>`).join('')}
          <label class="sr" for="pick-${n}">Another category for ${e(u.label)}</label>
          <select id="pick-${n}" data-act="teach-select"><option value="">Something else…</option>${options}</select>
        </div>
      </li>`
    }).join('')}</ul>
    ${queue.length > 8 ? `<p class="section-note">and ${queue.length - 8} more, smaller ones. You can change any line's category in the list at the bottom.</p>` : ''}`

  paintWhere(s)
  paintReply(s)
  paintLines(s)
  paintStatus()
}

function paintWhere(s: State): void {
  const {summary} = s
  const months = summary.months
  const W = 720
  const H = 250
  const padT = 16
  const padL = 46
  const padB = 26
  const top = Math.max(1, ...months.map(m => [...summary.byMonth.get(m)!.values()].reduce((a, b) => a + b, 0)))
  // A round number just above the tallest month, for the axis.
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].map(d => d * 100).find(d => top / d <= 4) ?? Math.ceil(top / 4)
  const ceiling = Math.ceil(top / step) * step
  const slot = (W - padL) / months.length
  const barW = Math.min(64, slot * 0.62)
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / ceiling)
  const order = CATEGORIES.filter(c => c.spending).map(c => c.id)
  let bars = ''
  for (let line = 0; line <= ceiling; line += step) {
    bars += `<line x1="${padL}" x2="${W}" y1="${y(line).toFixed(1)}" y2="${y(line).toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y(line) + 4).toFixed(1)}" class="axis" text-anchor="end">${money(line, true)}</text>`
  }
  months.forEach((m, i) => {
    const x = padL + slot * i + (slot - barW) / 2
    let base = 0
    const cats = summary.byMonth.get(m)!
    for (const id of order) {
      const v = cats.get(id) ?? 0
      if (!v) continue
      const h = ((H - padB - padT) * v) / ceiling
      bars += `<rect x="${x.toFixed(1)}" y="${(y(base) - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, h - 1).toFixed(1)}" class="seg c-${id}${s.onlyCategory && s.onlyCategory !== id ? ' dim' : ''}" data-act="category" data-category="${id}"><title>${e(category(id).label)}, ${monthLabel(m)}: ${money(v)}</title></rect>`
      base += v
    }
    bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="middle">${monthLabel(m).slice(0, 3)}</text><text x="${(x + barW / 2).toFixed(1)}" y="${(y(base) - 6).toFixed(1)}" class="total" text-anchor="middle">${money(base, true)}</text>`
  })
  const max = summary.byCategory[0]?.total ?? 1
  $('where').innerHTML = `
    <h2 id="where-h">Where it goes</h2>
    <div class="where">
      <figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending by month, stacked by category">${bars}</svg><figcaption>Spending by month. Transfers to savings, cards and people are left out.</figcaption></figure>
      <ul class="cats">${summary.byCategory.map(c => `
        <li><button type="button" class="cat-row${s.onlyCategory === c.id ? ' on' : ''}" data-act="category" data-category="${c.id}" aria-pressed="${s.onlyCategory === c.id}">
          <span class="swatch c-${c.id}" aria-hidden="true"></span><span class="cat-name">${e(category(c.id).label)}</span>
          <svg class="cat-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width="${((c.total / max) * 100).toFixed(1)}" height="6" class="seg c-${c.id}"/></svg>
          <span class="cat-total">${money(c.total, true)}</span><span class="cat-share">${Math.round((c.total / Math.max(1, summary.spent)) * 100)}%</span>
        </button></li>`).join('')}</ul>
    </div>`
}

function paintReply(s: State): void {
  const el = $('answer')
  if (!s.reply) {
    el.innerHTML = ''
    return
  }
  const {answer: a, understood} = s.reply
  el.innerHTML = `<div class="reply"><p class="reply-main">${e(a.text)}</p><p class="reply-detail">${e(a.detail)}</p><p class="reply-how">Understood as: ${e(understood)}${a.txnIds.length ? ` · <button type="button" class="link" data-act="reply-lines">See the ${plural(a.txnIds.length, 'line')}</button>` : ''}</p></div>`
}

function visible(s: State): Txn[] {
  const words = s.search.toLowerCase().split(/\s+/).filter(Boolean)
  return s.imported.txns.filter(t => {
    if (s.picked && !s.picked.ids.has(t.id)) return false
    if (s.onlyCategory && s.verdicts[t.id]!.category !== s.onlyCategory) return false
    if (words.length) {
      const hay = `${t.raw} ${t.label} ${category(s.verdicts[t.id]!.category).label}`.toLowerCase()
      if (!words.every(w => hay.includes(w))) return false
    }
    return true
  })
}

function paintLines(s: State): void {
  const rows = visible(s).reverse()
  const total = rows.reduce((sum, t) => sum + t.amount, 0)
  const options = (now: CategoryId) => CATEGORIES.map(c => `<option value="${c.id}"${c.id === now ? ' selected' : ''}>${e(c.label)}</option>`).join('')
  const filters: string[] = []
  if (s.picked) filters.push(`<button type="button" class="filter" data-act="clear-picked">${e(s.picked.label)} ✕</button>`)
  if (s.onlyCategory) filters.push(`<button type="button" class="filter" data-act="clear-category">${e(category(s.onlyCategory).label)} ✕</button>`)
  $('filters').innerHTML = filters.join('')
  $('line-count').textContent = `${plural(rows.length, 'line')}, net ${money(total)}`
  const how: Record<Verdict['reason']['how'], string> = {known: 'known merchant', model: 'model', taught: 'you taught it', rule: 'rule'}
  $('rows').innerHTML = rows.slice(0, s.shown).map(t => {
    const v = s.verdicts[t.id]!
    const unsure = t.amount < 0 && v.confidence < REVIEW_BELOW
    return `<tr class="${unsure ? 'unsure' : ''}">
      <td class="date">${formatDay(t.day, false)}</td>
      <td class="desc"><b>${e(t.label)}</b><small>${e(t.raw)}</small></td>
      <td class="cat"><select class="chip-select c-${v.category}" data-act="recat" data-id="${t.id}" aria-label="Category for ${e(t.label)}" ${t.amount > 0 ? 'disabled' : ''}>${options(v.category)}</select><button type="button" class="why-btn${unsure ? ' unsure' : ''}" data-act="why" data-id="${t.id}" aria-label="Why ${e(category(v.category).label)}?">${how[v.reason.how]}${v.reason.how === 'model' ? ` ${Math.round(v.confidence * 100)}%` : ''}</button></td>
      <td class="num ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${money(Math.abs(t.amount))}</td>
    </tr>`
  }).join('') || '<tr><td colspan="4" class="empty">No lines match.</td></tr>'
  const more = $('more')
  more.hidden = rows.length <= s.shown
  more.textContent = `Show ${Math.min(100, rows.length - s.shown)} more`
}

/** Builds the parts of the page that hold inputs, once, so typing never loses its place. */
let mounted = false
function mountOnce(): void {
  if (mounted) return
  mounted = true
  const examples = ['How much did I spend on coffee last month?', 'How many times did I use Uber?', 'What do my subscriptions cost?', 'How much went on food delivery since August?', 'Biggest purchase in July?']
  $('ask').innerHTML = `
    <h2 id="ask-h">Ask your statement</h2>
    <p class="section-note">Plain questions, answered by adding up the matching lines. The model works out what you mean: “getting around” finds the rides and the transit pass.</p>
    <form id="ask-form" class="ask-form"><label class="sr" for="question">Your question</label><input id="question" type="text" autocomplete="off" placeholder="How much did I spend on coffee last month?" maxlength="160"><button class="btn primary" type="submit">Ask</button></form>
    <div class="examples">${examples.map(x => `<button type="button" class="example" data-act="example">${e(x)}</button>`).join('')}</div>
    <div id="answer" aria-live="polite"></div>`
  $('lines').innerHTML = `
    <h2 id="lines-h">Every line</h2>
    <div class="tools"><label class="sr" for="search">Search lines</label><input id="search" type="search" placeholder="Search merchant or description" autocomplete="off"><span id="filters" class="filters"></span><span id="line-count" class="line-count"></span></div>
    <div class="table-wrap"><table class="lines"><thead><tr><th scope="col">Date</th><th scope="col">Merchant</th><th scope="col">Category</th><th scope="col" class="num">Amount</th></tr></thead><tbody id="rows"></tbody></table></div>
    <button type="button" class="btn quiet" id="more" data-act="more" hidden>Show more</button>`
  $('search').addEventListener('input', event => {
    if (!state) return
    state.search = (event.target as HTMLInputElement).value
    state.shown = 60
    paintLines(state)
  })
  $('ask-form').addEventListener('submit', event => {
    event.preventDefault()
    void ask(($('question') as HTMLInputElement).value)
  })
}

// ---------------------------------------------------------------- actions

function toast(text: string): void {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout((toast as any).timer)
  ;(toast as any).timer = setTimeout(() => (el.hidden = true), 5200)
}

function pick(ids: number[], label: string): void {
  if (!state) return
  state.picked = {ids: new Set(ids), label}
  state.onlyCategory = ''
  state.shown = 60
  paintLines(state)
  $('lines').scrollIntoView({behavior: 'smooth', block: 'start'})
}

async function teach(merchant: string, to: CategoryId): Promise<void> {
  if (!state) return
  const s = state
  const before = s.verdicts.map(v => v.category)
  let vec = vectors.get(merchant) ?? null
  if (!vec && modelState !== 'failed') {
    try {
      vec = (await embed([merchant])).slice(0, DIM)
      vectors.set(merchant, vec)
    } catch {
      vec = null
    }
  }
  classifier.teach(merchant, to, vec)
  saveTaught()
  classifyAll(s)
  const own = s.imported.txns.filter(t => t.merchant === merchant)
  const others = new Set(s.imported.txns.filter(t => t.merchant !== merchant && s.verdicts[t.id]!.category !== before[t.id] && s.verdicts[t.id]!.reason.how === 'taught').map(t => t.label))
  paint()
  const label = own[0]?.label ?? merchant
  toast(`Learned: ${label} is ${category(to).label}. ${plural(own.length, 'line')} updated${others.size ? `, and ${[...others].slice(0, 2).join(' and ')} followed because the name is close` : ''}. Saved on this device only.`)
}

async function ask(question: string): Promise<void> {
  if (!state || !question.trim()) return
  const s = state
  const parsed = parseQuestion(question, s.summary.endDay)
  let target: Target | null = targetWithoutModel(parsed, s.imported.txns, s.recurring)
  let understood = target ? target.label : ''
  if (!target) {
    $('answer').innerHTML = '<div class="reply"><p class="reply-detail">Working out what you mean…</p></div>'
    try {
      await bankReady
      const vec = (await embed([parsed.subject])).slice(0, DIM)
      // Nearest merchants in this statement, by meaning.
      const close: {merchant: string; label: string; score: number}[] = []
      const seen = new Set<string>()
      for (const t of s.imported.txns) {
        if (seen.has(t.merchant) || t.amount >= 0) continue
        seen.add(t.merchant)
        const v = vectors.get(t.merchant)
        if (!v) continue
        let score = 0
        for (let i = 0; i < DIM; i++) score += v[i]! * vec[i]!
        if (score >= 0.62) close.push({merchant: t.merchant, label: t.label, score})
      }
      const verdict = classifier.classify(parsed.subject, parsed.subject, -1, vec)
      if (verdict.category !== 'other' && verdict.confidence >= 0.3) {
        target = targetForCategory(verdict.category)
        if (verdict.kind && verdict.reason.how === 'model' && verdict.reason.neighbours[0]!.score >= 0.75) {
          // A narrow idea ("video streaming"): only the lines of that kind.
          const kind = verdict.kind
          const narrow = (t: Txn, v: Verdict) => t.amount < 0 && v.kind === kind
          if (s.imported.txns.some(t => narrow(t, s.verdicts[t.id]!))) target = {label: kind, test: narrow}
        }
        understood = target.label.toLowerCase() === parsed.subject ? `“${parsed.subject}”, matched by meaning with the on-device model` : `“${parsed.subject}” means ${target.label} (matched by the on-device model)`
      } else if (close.length) {
        const names = new Set(close.map(c => c.merchant))
        target = {label: close.slice(0, 3).map(c => c.label).join(', '), test: t => t.amount < 0 && names.has(t.merchant)}
        understood = `merchants close in meaning to “${parsed.subject}”`
      }
    } catch (err) {
      console.error(err)
    }
  }
  if (!target) {
    s.reply = {question, answer: {text: `I could not tell what “${parsed.subject}” refers to in this statement.`, detail: 'Try a merchant name (netflix), a category (groceries) or an idea (eating out, getting around).', txnIds: []}, understood: 'nothing matched'}
  } else {
    const a = answer(parsed, target, s.imported.txns, s.verdicts)
    const metric = {sum: 'total', count: 'count', average: 'average', biggest: 'biggest single line'}[parsed.metric]
    s.reply = {question, answer: a, understood: `${metric} · ${understood} · ${parsed.range ? parsed.range.label : 'whole statement'}`}
  }
  paintReply(s)
}

function showWhy(button: HTMLElement, t: Txn, v: Verdict): void {
  const el = $('why')
  let body = ''
  if (v.reason.how === 'known') body = `<p>The cleaned name <code>${e(t.merchant)}</code> matches the known merchant <b>${e(v.reason.example)}</b>, word for word. No model needed.</p>`
  else if (v.reason.how === 'rule') body = `<p>${e(v.reason.rule)}. Decided by a plain rule, no model needed.</p>`
  else if (v.reason.how === 'taught') body = `<p>You taught it: <b>${e(v.reason.example)}</b> is ${e(category(v.category).label)}${v.reason.score < 1 ? `, and this name is ${Math.round(v.reason.score * 100)}% alike in meaning` : ''}. Saved on this device.</p>`
  else {
    body = `<p>The model read <code>${e(t.merchant)}</code> and found these closest examples by meaning:</p><ol>${v.reason.neighbours.map(n => `<li><span>${e(n.text)}</span> ${chip(n.category)} <b>${Math.round(n.score * 100)}%</b></li>`).join('')}</ol><p>Confidence ${Math.round(v.confidence * 100)}%${v.confidence < REVIEW_BELOW ? ', so it asked you to check' : ''}.</p>`
  }
  el.innerHTML = `<h3>Why ${e(category(v.category).label)}?</h3>${body}<button type="button" class="link" data-act="close-why">Close</button>`
  el.hidden = false
  const box = button.getBoundingClientRect()
  const width = Math.min(360, window.innerWidth - 24)
  el.style.width = `${width}px`
  el.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, box.left + window.scrollX - 40))}px`
  el.style.top = `${box.bottom + window.scrollY + 8}px`
}

function exportCsv(s: State): void {
  const regular = new Map(s.recurring.map(r => [r.merchant, r.cadence]))
  const rows: (string | number)[][] = [['Date', 'Description', 'Merchant', 'Category', 'Amount', 'Decided by', 'Confidence', 'Regular']]
  for (const t of s.imported.txns) {
    const v = s.verdicts[t.id]!
    rows.push([isoDay(t.day), t.raw, t.label, category(v.category).label, (t.amount / 100).toFixed(2), v.reason.how, v.confidence.toFixed(2), regular.get(t.merchant) ?? ''])
  }
  const url = URL.createObjectURL(new Blob([toCsv(rows)], {type: 'text/csv'}))
  const a = document.createElement('a')
  a.href = url
  a.download = 'loose-change-sorted.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

document.addEventListener('click', event => {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
  const why = $('why')
  if (!why.hidden && !(event.target as HTMLElement).closest('#why') && el?.dataset.act !== 'why') why.hidden = true
  if (!el) return
  const act = el.dataset.act
  const s = state
  if (act === 'close-why') return void (why.hidden = true)
  if (!s) return
  const i = Number(el.dataset.i)
  if (act === 'alert-lines') pick(s.alerts[i]!.txnIds, s.alerts[i]!.title)
  else if (act === 'regular-lines') pick(s.recurring[i]!.txnIds, s.recurring[i]!.label)
  else if (act === 'reply-lines' && s.reply) pick(s.reply.answer.txnIds, s.reply.question)
  else if (act === 'clear-picked') {
    s.picked = null
    paintLines(s)
  } else if (act === 'clear-category' || act === 'category') {
    const id = (el.dataset.category ?? '') as CategoryId | ''
    s.onlyCategory = act === 'clear-category' || s.onlyCategory === id ? '' : id
    s.picked = null
    s.shown = 60
    paintWhere(s)
    paintLines(s)
  } else if (act === 'more') {
    s.shown += 100
    paintLines(s)
  } else if (act === 'teach') {
    void teach(el.closest<HTMLElement>('[data-merchant]')!.dataset.merchant!, el.dataset.category as CategoryId)
  } else if (act === 'example') {
    ;($('question') as HTMLInputElement).value = el.textContent ?? ''
    void ask(el.textContent ?? '')
  } else if (act === 'why') {
    const t = s.imported.txns[Number(el.dataset.id)]!
    showWhy(el, t, s.verdicts[t.id]!)
  } else if (act === 'export') exportCsv(s)
  else if (act === 'reset') {
    const forget = classifier.taught.length > 0 && confirm(`Also forget the ${plural(classifier.taught.length, 'correction')} you taught it on this device?`)
    if (forget) {
      classifier.taught = []
      saveTaught()
    }
    state = null
    $('app').hidden = true
    $('start').hidden = false
    ;($('file') as HTMLInputElement).value = ''
    window.scrollTo({top: 0})
  }
})

document.addEventListener('change', event => {
  const el = event.target as HTMLInputElement | HTMLSelectElement
  const s = state
  if (!s) return
  if (el.dataset.act === 'drop') {
    const r = s.recurring[Number(el.dataset.i)]!
    if ((el as HTMLInputElement).checked) s.dropped.add(r.merchant)
    else s.dropped.delete(r.merchant)
    paint()
  } else if (el.dataset.act === 'recat') {
    const t = s.imported.txns[Number(el.dataset.id)]!
    void teach(t.merchant, el.value as CategoryId)
  } else if (el.dataset.act === 'teach-select' && el.value) {
    void teach(el.closest<HTMLElement>('[data-merchant]')!.dataset.merchant!, el.value as CategoryId)
  }
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('why').hidden = true
})

// ---------------------------------------------------------------- start page

async function readFile(file: File): Promise<void> {
  if (file.size > 20 * 1024 * 1024) {
    $('start-error').hidden = false
    $('start-error').textContent = 'That file is over 20 MB, which is more than a statement should be.'
    return
  }
  open(await file.text(), file.name)
}

const drop = $('drop')
const fileInput = $<HTMLInputElement>('file')
drop.addEventListener('click', () => fileInput.click())
drop.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    fileInput.click()
  }
})
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) void readFile(file)
})
window.addEventListener('dragover', event => {
  event.preventDefault()
  drop.classList.add('over')
})
window.addEventListener('dragleave', event => {
  if (!event.relatedTarget) drop.classList.remove('over')
})
window.addEventListener('drop', event => {
  event.preventDefault()
  drop.classList.remove('over')
  const file = event.dataTransfer?.files?.[0]
  if (file) void readFile(file)
})
$('try-sample').addEventListener('click', () => open(sampleStatement(), 'sample-statement.csv'))

const dialog = $<HTMLDialogElement>('privacy')
$('privacy-pill').addEventListener('click', () => {
  const outside = performance.getEntriesByType('resource').filter(r => !r.name.startsWith(location.origin) && !r.name.startsWith('blob:') && !r.name.startsWith('data:')).length
  $('privacy-proof').textContent = `Checked just now: since this tab opened it has made ${outside} request${outside === 1 ? '' : 's'} to any other server.`
  dialog.showModal()
})
$('privacy-close').addEventListener('click', () => dialog.close())

// What the classifier scored when it was last measured (written by the build).
fetch('accuracy.json').then(r => (r.ok ? r.json() : null)).then(a => {
  if (!a?.heldOut) return
  $('measured').innerHTML = `<p><b>Measured, not promised.</b> On ${a.heldOut.rows} statement lines from merchants it had never been told about, the on-device model picked the right category ${a.heldOut.accuracy}% of the time. When it said it was confident (${a.heldOut.whenConfident.share}% of lines) it was right ${a.heldOut.whenConfident.accuracy}% of the time; the rest it sent to you to check.</p>`
}).catch(() => {})

// Fetch the model while the visitor reads the start page, so the first statement is quick.
if ('requestIdleCallback' in window) requestIdleCallback(() => startModel(), {timeout: 2500})
else setTimeout(startModel, 1200)

// A hook for the automated browser checks.
;(window as any).__looseChange = {state: () => state, model: () => modelState, vectors: () => vectors.size}
