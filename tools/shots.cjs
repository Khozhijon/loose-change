// Takes the gallery screenshots and records the demo video from the local server.
//
//   npm run dev                      (in one terminal)
//   node tools/shots.cjs             screenshots into submission/
//   node tools/shots.cjs video       the walkthrough video into submission/demo.webm
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0'
const path = require('node:path')
const fs = require('node:fs')
const {createRequire} = require('node:module')
// Playwright from this project if it is installed here, otherwise from the folder above.
let chromium
try {
  ;({chromium} = require('playwright'))
} catch {
  ;({chromium} = createRequire(path.join(__dirname, '..', '..', 'package.json'))('playwright'))
}

const base = process.env.BASE ?? 'http://localhost:5177'
const out = path.join(__dirname, '..', 'submission')
const pause = ms => new Promise(done => setTimeout(done, ms))
const ready = page => page.waitForFunction(() => window.__looseChange.state() && window.__looseChange.state().waiting === 0 && window.__looseChange.model() === 'ready', null, {timeout: 60000})
const top = (page, selector, offset = 12) => page.evaluate(([sel, off]) => window.scrollTo(0, document.querySelector(sel).getBoundingClientRect().top + window.scrollY - off), [selector, offset])

async function shots(browser) {
  const done = []
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: 2})
  const page = await context.newPage()
  const shot = async name => {
    await pause(350)
    await page.screenshot({path: path.join(out, name)})
    done.push(name)
  }
  await page.goto(base)
  await page.waitForFunction(() => window.__looseChange.model() === 'ready')
  await shot('1-start.png')
  await page.click('#try-sample')
  await ready(page)
  await shot('2-headline.png')
  await top(page, '.alerts li:nth-child(3)')
  await shot('3-alerts.png')
  await page.locator('#regular tr', {hasText: 'Hulu'}).locator('input').check()
  await page.locator('#regular tr', {hasText: 'Disney Plus'}).locator('input').check()
  await page.locator('#regular tr', {hasText: 'Chegg'}).locator('input').check()
  await top(page, '#regular')
  await shot('4-regular.png')
  await top(page, '#review')
  await shot('5-unsure-and-where.png')
  await page.fill('#question', 'How much went on food delivery since August?')
  await page.click('#ask-form button')
  await page.waitForSelector('.reply-main')
  await page.click('[data-act="reply-lines"]')
  await pause(700)
  await top(page, '#ask')
  await shot('6-ask.png')
  await page.click('[data-act="clear-picked"]')
  await page.fill('#search', 'golden dragon')
  await page.locator('#rows [data-act="why"]').first().click()
  await top(page, '#lines')
  await shot('7-why.png')
  await context.close()

  const phone = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 3, colorScheme: 'dark', hasTouch: true})
  const small = await phone.newPage()
  await small.goto(base)
  await small.click('#try-sample')
  await ready(small)
  await pause(400)
  await small.screenshot({path: path.join(out, '8-phone-dark.png')})
  done.push('8-phone-dark.png')
  await phone.close()
  return done
}

async function video(browser) {
  const dir = path.join(out, 'video-tmp')
  fs.rmSync(dir, {recursive: true, force: true})
  const context = await browser.newContext({viewport: {width: 1280, height: 720}, recordVideo: {dir, size: {width: 1280, height: 720}}})
  const page = await context.newPage()
  await page.goto(base)
  // A caption bar drawn over the page, styled from script because the page forbids inline styles.
  const say = async (text, ms) => {
    await page.evaluate(t => {
      let bar = document.getElementById('demo-caption')
      if (!bar) {
        bar = document.createElement('div')
        bar.id = 'demo-caption'
        Object.assign(bar.style, {position: 'fixed', left: '50%', bottom: '26px', transform: 'translateX(-50%)', background: 'rgba(20,26,22,0.94)', color: '#fffdf7', padding: '14px 26px', borderRadius: '14px', font: '600 22px/1.35 system-ui, sans-serif', zIndex: '99', maxWidth: '1040px', textAlign: 'center', boxShadow: '0 12px 40px -12px rgba(0,0,0,0.6)'})
        document.body.appendChild(bar)
      }
      bar.textContent = t
    }, text)
    // Long enough to read each caption twice.
    await pause(Math.round(ms * 1.4))
  }
  const glide = async (selector, offset = 90) => {
    await page.evaluate(([sel, off]) => window.scrollTo({top: document.querySelector(sel).getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth'}), [selector, offset])
    await pause(900)
  }
  await page.waitForFunction(() => window.__looseChange.model() === 'ready')
  await say('Loose Change: an AI model that reads your bank statement inside your own browser tab.', 4200)
  await say('Nothing is uploaded. The page itself forbids any connection to another server.', 3800)
  await page.click('#privacy-pill')
  await pause(3600)
  await page.click('#privacy-close')
  await say('Drop in a CSV from any bank. Here is the built-in sample: six months of an invented student account.', 3600)
  await page.click('#try-sample')
  await ready(page)
  await say('400 lines sorted in about a second. $791 a year is leaving in fees, price rises and double charges.', 5200)
  await glide('.sorted', 420)
  await say('258 lines matched known merchants, 97 were read by the on-device model, 45 followed plain rules.', 4400)
  await glide('#alerts')
  await say('Every finding names the exact lines behind it: charged twice, a $1 trial that became $22.99 a month…', 5200)
  await glide('.alerts li:nth-child(4)')
  await say('…prices that went up, bank fees added up over a year, three streaming services at once.', 5200)
  await glide('#regular')
  await say('Regular charges are found by the rhythm of their dates, not from a list of names.', 4200)
  await page.locator('#regular tr', {hasText: 'Hulu'}).locator('input').check()
  await pause(500)
  await page.locator('#regular tr', {hasText: 'Disney Plus'}).locator('input').check()
  await pause(500)
  await page.locator('#regular tr', {hasText: 'Chegg'}).locator('input').check()
  await glide('.back', 420)
  await say('Tick what you would drop and it adds up what comes back each year.', 4200)
  await glide('#review')
  await say('When the model is unsure it says so. Teach it once: Thinking Cup is a coffee shop.', 4200)
  await page.locator('.review li', {hasText: 'Thinking Cup'}).locator('select').selectOption('coffee')
  await say('18 lines updated. The correction is saved on this device only.', 4600)
  await glide('#ask')
  await say('Ask in plain words. The same model works out what you mean.', 2600)
  await page.locator('#question').pressSequentially('How much went on food delivery since August?', {delay: 38})
  await page.click('#ask-form button')
  await page.waitForSelector('.reply-main')
  await say('“Food delivery” was matched to the DoorDash lines by meaning, then simply added up.', 5200)
  await glide('#lines')
  await page.fill('#search', 'golden dragon')
  await pause(600)
  await page.locator('#rows [data-act="why"]').first().click()
  await say('Every category can explain itself: here, the nearest examples the model found.', 5200)
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'}))
  await say('Measured on merchants it had never seen: right 90.4% of the time, and it flags the ones it is unsure about.', 4800)
  // The proof that nothing is sent anywhere: switch the network off and do it all again.
  await context.setOffline(true)
  page.on('dialog', dialog => void dialog.dismiss())
  await page.evaluate(() => window.scrollTo({top: 0, behavior: 'smooth'}))
  await say('Now the network is switched off.', 2400)
  await page.click('[data-act="reset"]')
  await pause(900)
  await page.click('#try-sample')
  await ready(page)
  await say('It still works. The model is a file on this device, not a service somewhere else.', 4600)
  await say('Loose Change. Find the money that leaves quietly, without handing anyone your statement.', 4600)
  await context.close()
  const file = fs.readdirSync(dir).find(f => f.endsWith('.webm'))
  fs.renameSync(path.join(dir, file), path.join(out, 'demo.webm'))
  fs.rmSync(dir, {recursive: true, force: true})
  return ['demo.webm']
}

;(async () => {
  const browser = await chromium.launch({headless: true})
  try {
    const files = process.argv[2] === 'video' ? await video(browser) : await shots(browser)
    console.log(JSON.stringify({ok: true, files: files.map(f => ({file: f, bytes: fs.statSync(path.join(out, f)).size}))}))
  } catch (err) {
    console.log(JSON.stringify({ok: false, error: String(err.message).split('\n')[0]}))
    process.exitCode = 1
  } finally {
    await browser.close()
  }
})()
