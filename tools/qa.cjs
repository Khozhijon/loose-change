// Plays the app end to end in a real browser and fails on any error.
//
//   npm run dev          (in one terminal)
//   npm run qa           (in another)
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0'
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {createRequire} = require('node:module')
// Playwright from this project if it is installed here, otherwise from the folder above.
let chromium
try {
  ;({chromium} = require('playwright'))
} catch {
  ;({chromium} = createRequire(path.join(__dirname, '..', '..', 'package.json'))('playwright'))
}

const base = process.env.BASE ?? 'http://localhost:5177'
const results = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loose-change-qa-'))

function check(ok, message) {
  if (!ok) throw new Error(message)
}

async function fresh(browser, options = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true, ...options})
  const page = await context.newPage()
  const problems = []
  const outside = []
  page.on('pageerror', err => problems.push(`page error: ${err.message}`))
  page.on('console', msg => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`)
  })
  page.on('dialog', dialog => {
    problems.push(`unexpected dialog: ${dialog.message()}`)
    void dialog.dismiss()
  })
  page.on('request', req => {
    const url = req.url()
    if (!url.startsWith(base) && !url.startsWith('blob:') && !url.startsWith('data:')) outside.push(url)
  })
  await page.goto(base)
  return {context, page, problems, outside}
}

const modelReady = page => page.waitForFunction(() => window.__looseChange.model() === 'ready', null, {timeout: 60000})
const allRead = page => page.waitForFunction(() => window.__looseChange.state() && window.__looseChange.state().waiting === 0 && window.__looseChange.model() === 'ready', null, {timeout: 60000})
const state = (page, fn) => page.evaluate(fn)

async function sample(page) {
  await page.click('#try-sample')
  await page.waitForSelector('#headline .receipt')
  await allRead(page)
  // One more frame so the last repaint is in.
  await page.waitForTimeout(150)
}

async function ask(page, question) {
  await page.fill('#question', question)
  await page.click('#ask-form button')
  await page.waitForFunction(q => window.__looseChange.state().reply && window.__looseChange.state().reply.question === q, question, {timeout: 20000})
  return page.textContent('.reply-main')
}

const scenarios = {
  'start page loads, the model starts, nothing leaves the address': async browser => {
    const {context, page, problems, outside} = await fresh(browser)
    await modelReady(page)
    check((await page.textContent('h1')).includes('Find the money'), 'headline missing')
    check((await page.textContent('#measured')).includes('Measured, not promised'), 'measured accuracy missing')
    check(outside.length === 0, `requests to other servers: ${outside.join(', ')}`)
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'sample statement: every planted leak is on the page': async browser => {
    const {context, page, problems, outside} = await fresh(browser)
    await sample(page)
    const text = await page.textContent('#alerts')
    for (const part of ['La Casa De Pedro charged you twice', 'Chegg charged you twice', 'Adobe trial became a paid plan', 'New York Times went up', 'Comcast went up', 'Netflix went up', 'wire fees', 'account fees', 'ATM fees', 'foreign transaction fees', 'overdraft fee', '3 video streaming subscriptions', 'New regular charge: ChatGPT']) {
      check(text.includes(part), `alert missing: ${part}`)
    }
    check((await page.textContent('#headline .big')) === '$791', `headline is ${await page.textContent('#headline .big')}`)
    check((await page.locator('#regular tbody tr').count()) === 17, 'expected 17 regular charges')
    check((await page.textContent('#model-status')).startsWith('All 65 merchants read'), `status: ${await page.textContent('#model-status')}`)
    const byModel = await state(page, () => window.__looseChange.state().verdicts.filter(v => v.reason.how === 'model').length)
    check(byModel > 40, `only ${byModel} lines were decided by the model`)
    check((await page.locator('#where svg rect.seg').count()) > 40, 'chart has too few segments')
    check(outside.length === 0, `requests to other servers: ${outside.join(', ')}`)
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'an alert shows exactly its own lines': async browser => {
    const {context, page, problems} = await fresh(browser)
    await sample(page)
    await page.click('#alerts .alert:first-child [data-act="alert-lines"]')
    await page.waitForSelector('.filter')
    check((await page.locator('#rows tr').count()) === 2, 'the double charge should show 2 lines')
    check((await page.textContent('#rows')).includes('LA CASA DE PEDRO'), 'wrong lines shown')
    check((await page.textContent('#line-count')).includes('2 lines, net -$76.80'), `count line: ${await page.textContent('#line-count')}`)
    await page.click('[data-act="clear-picked"]')
    check((await page.locator('#rows tr').count()) === 60, 'clearing the filter should bring the list back')
    await page.click('#more')
    check((await page.locator('#rows tr').count()) === 160, '"show more" should add 100 lines')
    await page.fill('#search', 'netflix')
    check((await page.locator('#rows tr').count()) === 6, 'search for netflix should find 6 lines')
    await page.fill('#search', 'zzzz-nothing')
    check((await page.textContent('#rows')).includes('No lines match'), 'empty search should say so')
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'questions are answered from the lines, by meaning': async browser => {
    const {context, page, problems} = await fresh(browser)
    await sample(page)
    const want = [
      ['How much did I spend on coffee last month?', /^\$\d+\.\d\d for Coffee & snacks in September 2026\.$/],
      ['How many times did I use Uber?', /^10 payments for uber trip in this statement, \$108\.12 in all\.$/],
      ['What do my subscriptions cost?', /^\$490\.11 for subscriptions in this statement\.$/],
      ['How much went on food delivery since August?', /for food delivery since August 2026\.$/],
      ['what did I pay for video streaming', /^\$244\.32 for video streaming in this statement\.$/],
      ['how much on getting around in the last 3 months', /for Getting around in the last 3 months\.$/],
      ['how much for rent', /^\$6,900\.00 for Housing in this statement\.$/],
      ['how much did I pay in bank fees', /^\$217\.37 for bank fees in this statement\.$/],
      ['how much did I spend on xyzzy plugh', /could not tell what/],
    ]
    for (const [q, re] of want) {
      const got = await ask(page, q)
      check(re.test(got), `"${q}" answered "${got}"`)
    }
    await ask(page, 'what did I pay for video streaming')
    await page.click('[data-act="reply-lines"]')
    check((await page.locator('#rows tr').count()) === 18, 'video streaming should be 18 lines (Netflix, Hulu, Disney Plus)')
    await page.click('.example:first-child')
    await page.waitForFunction(() => window.__looseChange.state().reply.question.includes('coffee'))
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'teaching: one answer fixes every line, is remembered, and stays on the device': async browser => {
    const {context, page, problems, outside} = await fresh(browser)
    await sample(page)
    const before = await page.locator('.review li').count()
    check(before >= 3, `expected a few unsure merchants, got ${before}`)
    const card = page.locator('.review li', {hasText: 'Thinking Cup'})
    check((await card.count()) === 1, 'Thinking Cup should be in the unsure list')
    await card.locator('select').selectOption('coffee')
    await page.waitForFunction(() => !document.querySelector('#toast').hidden)
    check((await page.textContent('#toast')).includes('Learned: Thinking Cup is Coffee & snacks'), `toast: ${await page.textContent('#toast')}`)
    const after = await state(page, () => {
      const s = window.__looseChange.state()
      return s.imported.txns.filter(t => t.merchant === 'thinking cup').map(t => s.verdicts[t.id].category + ':' + s.verdicts[t.id].reason.how)
    })
    check(after.length > 5 && after.every(x => x === 'coffee:taught'), `after teaching: ${after.slice(0, 3)}`)
    check((await page.locator('.review li').count()) === before - 1, 'the unsure list should shrink by one')
    check((await page.evaluate(() => localStorage.getItem('loose-change:taught'))).includes('thinking cup'), 'correction not saved')
    // A fresh visit remembers it without being told again.
    await page.reload()
    await sample(page)
    check((await page.locator('.review li', {hasText: 'Thinking Cup'}).count()) === 0, 'the correction was forgotten after a reload')
    // Changing a category in the table teaches too.
    await page.fill('#search', 'bayview')
    await page.locator('#rows select').first().selectOption('other')
    await page.waitForFunction(() => window.__looseChange.state().verdicts.some(v => v.reason.how === 'taught' && v.category === 'other'))
    // Start over, forgetting the corrections.
    page.removeAllListeners('dialog')
    page.once('dialog', dialog => void dialog.accept())
    await page.click('[data-act="reset"]')
    await page.waitForSelector('#start:not([hidden])')
    check((await page.evaluate(() => localStorage.getItem('loose-change:taught'))) === '[]', 'corrections should be forgotten on request')
    check(outside.length === 0, `requests to other servers: ${outside.join(', ')}`)
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'why: every kind of decision explains itself': async browser => {
    const {context, page, problems} = await fresh(browser)
    await sample(page)
    for (const [search, part] of [['netflix', 'matches the known merchant'], ['overdraft', 'plain rule'], ['golden dragon', 'closest examples by meaning']]) {
      await page.fill('#search', search)
      await page.locator('#rows [data-act="why"]').first().click()
      await page.waitForSelector('#why:not([hidden])')
      check((await page.textContent('#why')).includes(part), `why for ${search}: ${await page.textContent('#why')}`)
      await page.keyboard.press('Escape')
      check(await page.locator('#why').isHidden(), 'Escape should close the explanation')
    }
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'regular charges: ticking adds up, categories filter': async browser => {
    const {context, page, problems} = await fresh(browser)
    await sample(page)
    await page.locator('#regular tr', {hasText: 'Hulu'}).locator('input').check()
    await page.locator('#regular tr', {hasText: 'Disney Plus'}).locator('input').check()
    check((await page.textContent('.back')).includes('$288 a year'), `back line: ${await page.textContent('.back')}`)
    await page.locator('#regular tr', {hasText: 'Netflix'}).locator('[data-act="regular-lines"]').click()
    check((await page.locator('#rows tr').count()) === 6, 'Netflix should show its 6 lines')
    await page.click('.cat-row:has-text("Groceries")')
    const cats = await page.locator('#rows select').evaluateAll(list => [...new Set(list.map(s => s.value))])
    check(cats.length === 1 && cats[0] === 'groceries', `category filter shows ${cats}`)
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'offline: with the network off, a statement is still read by the model': async browser => {
    const {context, page, problems} = await fresh(browser)
    await modelReady(page)
    await context.setOffline(true)
    await sample(page)
    check((await page.textContent('#model-status')).startsWith('All 65 merchants read'), `status offline: ${await page.textContent('#model-status')}`)
    const got = await ask(page, 'how much on getting around')
    check(/for Getting around in this statement/.test(got), `offline answer: ${got}`)
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'a real file: card statement with positive purchases, quotes and a balance column': async browser => {
    const {context, page, problems} = await fresh(browser)
    const file = path.join(tmp, 'card.csv')
    const lines = ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo']
    for (let m = 1; m <= 4; m++) {
      lines.push(`0${m}/05/2026,0${m}/06/2026,"NETFLIX.COM, INC 866-579-7172 CA",Entertainment,Sale,15.49,`)
      lines.push(`0${m}/09/2026,0${m}/10/2026,SQ *LITTLE OWL COFFEE DENVER CO,Food,Sale,${(4 + m / 10).toFixed(2)},`)
      lines.push(`0${m}/12/2026,0${m}/13/2026,CITY FRESH GROCERY 114 DENVER CO,Groceries,Sale,${(50 + m).toFixed(2)},`)
      lines.push(`0${m}/20/2026,0${m}/20/2026,AUTOPAY PAYMENT - THANK YOU,,Payment,-120.00,`)
    }
    fs.writeFileSync(file, lines.join('\n'))
    await page.setInputFiles('#file', file)
    await page.waitForSelector('#headline .receipt')
    await allRead(page)
    check((await page.textContent('#file-line')).includes('signs turned round'), 'positive purchases should be noticed')
    check((await page.textContent('#file-line')).includes('16 lines'), `file line: ${await page.textContent('#file-line')}`)
    check((await page.textContent('#regular')).includes('Netflix'), 'Netflix should be a regular charge')
    const got = await state(page, () => {
      const s = window.__looseChange.state()
      const of = m => s.verdicts[s.imported.txns.find(t => t.merchant.includes(m)).id].category
      return [of('little owl'), of('city fresh'), of('netflix')]
    })
    check(got.join() === 'coffee,groceries,subscriptions', `categories: ${got}`)
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'bad input: not a statement, an empty file, hostile text': async browser => {
    const {context, page, problems} = await fresh(browser)
    const junk = path.join(tmp, 'notes.txt')
    fs.writeFileSync(junk, 'Dear diary,\ntoday I did not export a statement.\n')
    await page.setInputFiles('#file', junk)
    await page.waitForSelector('#start-error:not([hidden])')
    check((await page.textContent('#start-error')).includes('could not be read as a statement'), 'bad file should be explained')
    const empty = path.join(tmp, 'empty.csv')
    fs.writeFileSync(empty, '')
    await page.setInputFiles('#file', empty)
    check(await page.locator('#start').isVisible(), 'an empty file must not open the results')
    const hostile = path.join(tmp, 'hostile.csv')
    fs.writeFileSync(hostile, 'Date,Description,Amount\n2026-05-01,"<img src=x onerror=alert(1)><script>alert(2)</script>",-5.00\n2026-05-02,"=HYPERLINK(""http://example.com"")",-6.00\n2026-06-01,"<b>bold</b> shop",-7.00\n')
    await page.setInputFiles('#file', hostile)
    await page.waitForSelector('#headline .receipt')
    await allRead(page)
    check((await page.locator('#rows img, #rows script, #rows b:has-text("bold") b').count()) === 0, 'statement text must never become markup')
    check((await page.textContent('#rows')).includes('<img src=x onerror=alert(1)>'), 'hostile text should be shown as plain text')
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'a long statement: 6,000 lines stay quick': async browser => {
    const {context, page, problems} = await fresh(browser)
    await modelReady(page)
    const big = path.join(tmp, 'big.csv')
    const shops = ['STARBUCKS STORE 0001', "TRADER JOE'S #512", 'UBER *TRIP', 'SQ *CORNER BAKERY', 'AMZN MKTP US*AB12CD34E', 'CHIPOTLE 1873', 'NETFLIX.COM', 'SHELL OIL 5744', 'CVS/PHARMACY #00218', 'TST* RIVER HOUSE GRILL']
    const rows = ['Date,Description,Amount']
    for (let i = 0; i < 6000; i++) {
      const day = new Date(Date.UTC(2024, 0, 1 + Math.floor(i / 9)))
      rows.push(`${day.toISOString().slice(0, 10)},${shops[i % shops.length]} ${i % 7},-${(3 + (i % 50)).toFixed(2)}`)
    }
    fs.writeFileSync(big, rows.join('\n'))
    const started = Date.now()
    await page.setInputFiles('#file', big)
    await page.waitForSelector('#headline .receipt')
    await allRead(page)
    const took = Date.now() - started
    check((await page.textContent('#file-line')).includes('6000 lines'), `file line: ${await page.textContent('#file-line')}`)
    check(took < 15000, `6,000 lines took ${took} ms`)
    check((await page.locator('#rows tr').count()) === 60, 'only the first screen of lines should be drawn')
    check(problems.length === 0, problems.join('; '))
    await context.close()
    return `${took} ms`
  },

  'phone width, dark mode, keyboard': async browser => {
    for (const [width, scheme] of [[390, 'light'], [390, 'dark'], [768, 'dark']]) {
      const {context, page, problems} = await fresh(browser, {viewport: {width, height: 800}, colorScheme: scheme, hasTouch: width < 500})
      const sideways = () => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      check((await sideways()) <= 0, `start page scrolls sideways at ${width}px`)
      await sample(page)
      check((await sideways()) <= 0, `results scroll sideways at ${width}px by ${await sideways()}px`)
      check(problems.length === 0, problems.join('; '))
      await context.close()
    }
    const {context, page, problems} = await fresh(browser)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    check((await page.evaluate(() => document.activeElement.id)) === 'drop', `fourth Tab stop is ${await page.evaluate(() => document.activeElement.id)}`)
    const chooser = page.waitForEvent('filechooser')
    await page.keyboard.press('Enter')
    await chooser
    await page.click('#privacy-pill')
    await page.waitForSelector('dialog[open]')
    check((await page.textContent('#privacy-proof')).includes('made 0 requests to any other server'), `proof: ${await page.textContent('#privacy-proof')}`)
    await page.click('#privacy-close')
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },

  'saving: the sorted statement downloads as CSV': async browser => {
    const {context, page, problems} = await fresh(browser)
    await sample(page)
    const wait = page.waitForEvent('download')
    await page.click('[data-act="export"]')
    const download = await wait
    const saved = path.join(tmp, 'saved.csv')
    await download.saveAs(saved)
    const text = fs.readFileSync(saved, 'utf8').trim().split('\n')
    check(download.suggestedFilename() === 'loose-change-sorted.csv', 'wrong file name')
    check(text.length === 401, `expected 401 rows, got ${text.length}`)
    check(text[0] === 'Date,Description,Merchant,Category,Amount,Decided by,Confidence,Regular', `header: ${text[0]}`)
    check(text.some(l => l.includes('Netflix,Subscriptions,-15.49,known,0.97,monthly')), 'a Netflix row should be in the export')
    check(problems.length === 0, problems.join('; '))
    await context.close()
  },
}

;(async () => {
  const browser = await chromium.launch({headless: true})
  const only = process.argv[2]
  let failed = 0
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !name.includes(only)) continue
    const started = Date.now()
    try {
      const note = await run(browser)
      results.push({name, ok: true, ms: Date.now() - started, ...(note ? {note} : {})})
    } catch (err) {
      failed++
      results.push({name, ok: false, ms: Date.now() - started, error: String(err.message).split('\n')[0]})
    }
  }
  await browser.close()
  fs.rmSync(tmp, {recursive: true, force: true})
  console.log(JSON.stringify({passed: results.length - failed, failed, results}, null, 1))
  console.log(`QA_DONE ${results.length - failed}/${results.length} passed`)
  process.exitCode = failed ? 1 : 0
})()
