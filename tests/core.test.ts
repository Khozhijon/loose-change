import assert from 'node:assert/strict'
import {test} from 'node:test'
import {findAlerts, looseChange} from '../src/core/alerts.ts'
import {answer, parseQuestion, targetWithoutModel} from '../src/core/ask.ts'
import {BANK} from '../src/core/bank.ts'
import {byRule, canonical, Classifier, findKnown} from '../src/core/classify.ts'
import {cleanMerchant} from '../src/core/clean.ts'
import {guessDelimiter, importStatement, mapColumns, parseAmount, parseDelimited, toCsv} from '../src/core/csv.ts'
import {formatDay, guessOrder, monthIndex, monthLabel, parseDate, toDay} from '../src/core/dates.ts'
import {money} from '../src/core/money.ts'
import {findRecurring, upcoming} from '../src/core/recurring.ts'
import {SAMPLE_END, SAMPLE_START, sampleStatement} from '../src/core/sample.ts'
import {summarise} from '../src/core/summary.ts'

test('dates: the common bank formats', () => {
  const want = toDay(2026, 3, 4)
  assert.equal(parseDate('2026-03-04'), want)
  assert.equal(parseDate('03/04/2026'), want)
  assert.equal(parseDate('04/03/2026', 'dmy'), want)
  assert.equal(parseDate('3/4/26'), want)
  assert.equal(parseDate('4 Mar 2026'), want)
  assert.equal(parseDate('04-Mar-26'), want)
  assert.equal(parseDate('Mar 4, 2026'), want)
  assert.equal(parseDate('March 4th, 2026'), want)
  assert.equal(parseDate('2026/03/04 14:22'), want)
  assert.equal(parseDate('31/02/2026', 'dmy'), null)
  assert.equal(parseDate('hello'), null)
  assert.equal(formatDay(want), '4 Mar 2026')
  assert.equal(monthLabel(monthIndex(want)), 'Mar 2026')
})

test('dates: day-first columns are noticed', () => {
  assert.equal(guessOrder(['01/02/2026', '13/02/2026', '28/02/2026']), 'dmy')
  assert.equal(guessOrder(['01/02/2026', '02/13/2026']), 'mdy')
  assert.equal(guessOrder(['01/02/2026', '03/04/2026']), 'mdy')
})

test('amounts: signs, brackets, separators', () => {
  assert.equal(parseAmount('$1,234.56'), 123456)
  assert.equal(parseAmount('-12.30'), -1230)
  assert.equal(parseAmount('(45.00)'), -4500)
  assert.equal(parseAmount('45.00 DR'), -4500)
  assert.equal(parseAmount('1.234,56'), 123456)
  assert.equal(parseAmount('12,5'), 1250)
  assert.equal(parseAmount('1,250'), 125000)
  assert.equal(parseAmount('7'), 700)
  assert.equal(parseAmount('- $3.05'), -305)
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('n/a'), null)
  assert.equal(money(123456), '$1,234.56')
  assert.equal(money(-5), '-$0.05')
  assert.equal(money(123456, true), '$1,235')
})

test('csv: saved files cannot smuggle formulas into a spreadsheet', () => {
  const out = toCsv([['=HYPERLINK("http://x")', '+1+1', '@SUM(A1)', '-12.50', '-cmd', 'plain, text', 7]])
  assert.equal(out, `"'=HYPERLINK(""http://x"")",'+1+1,'@SUM(A1),-12.50,'-cmd,"plain, text",7\n`)
})

test('csv: quotes, delimiters, blank lines', () => {
  assert.deepEqual(parseDelimited('a,"b,1","say ""hi"""\r\n\r\n1,2,3\n', ','), [['a', 'b,1', 'say "hi"'], ['1', '2', '3']])
  assert.equal(guessDelimiter('Date;Text;Amount\n01.02.2026;x;1,50'), ';')
  assert.equal(guessDelimiter('Date\tText\tAmount\n'), '\t')
})

test('import: a plain bank export', () => {
  const r = importStatement('Date,Description,Amount\n05/01/2026,NETFLIX.COM 866-579-7172 CA,-15.49\n05/02/2026,PAYROLL ACME,500.00\nbad,row,here\n')
  assert.equal(r.txns.length, 2)
  assert.equal(r.txns[0]!.merchant, 'netflix')
  assert.equal(r.txns[0]!.amount, -1549)
  assert.equal(r.txns[1]!.amount, 50000)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.flipped, false)
})

test('import: separate debit and credit columns, with a balance column to ignore', () => {
  const r = importStatement('Posting Date,Details,Debit,Credit,Balance\n2026-05-01,RENT,1150.00,,2000.00\n2026-05-02,PAYROLL,,400.00,2400.00\n')
  assert.deepEqual(r.txns.map(t => t.amount), [-115000, 40000])
  assert.equal(r.columns.amount, 'Debit / Credit')
})

test('import: a card statement that lists purchases as positive numbers', () => {
  const r = importStatement('Transaction Date,Description,Amount\n05/01/2026,STARBUCKS,4.50\n05/02/2026,UBER *TRIP,12.00\n05/03/2026,TARGET,30.00\n05/04/2026,PAYMENT THANK YOU,-46.50\n')
  assert.equal(r.flipped, true)
  assert.deepEqual(r.txns.map(t => t.amount), [-450, -1200, -3000, 4650])
})

test('import: no header, semicolons, day-first dates, decimal commas', () => {
  const r = importStatement('13.05.2026;REWE MARKT BERLIN;-23,40\n14.05.2026;GEHALT;1.200,00\n')
  assert.equal(r.txns.length, 2)
  assert.equal(r.txns[0]!.day, toDay(2026, 5, 13))
  assert.deepEqual(r.txns.map(t => t.amount), [-2340, 120000])
})

test('import: a file that is not a statement fails with a reason, not a crash', () => {
  const r = importStatement('hello world\nthis is not a statement\n')
  assert.equal(r.txns.length, 0)
  assert.ok(r.skipped[0]!.why.length > 10)
  assert.equal(importStatement('').txns.length, 0)
  assert.equal(mapColumns([['a']]), null)
})

test('clean: bank noise comes off and the merchant stays', () => {
  const cases: [string, string][] = [
    ['POS DEBIT 0412 SQ *BLUE BOTTLE COF OAKLAND CA 94612 #2231', 'blue bottle cof'],
    ['TRUE VALUE HARDWARE 3391 OH', 'true value hardware'],
    ['APPLE.COM/BILL 866-712-7753 CA', 'apple bill'],
    ['NETFLIX.COM 866-579-7172 CA', 'netflix'],
    ['Purchase authorized on 08/14 TRADER JOE S #512 BOSTON MA S58 Card 4821', "trader joe's"],
    ['CVS/PHARMACY #00218 BOSTON MA', 'cvs pharmacy'],
    ['ZELLE PAYMENT TO ALEX M 18827364501', 'zelle payment to alex m'],
  ]
  for (const [raw, want] of cases) assert.equal(cleanMerchant(raw), want, raw)
  assert.equal(cleanMerchant('   '), '')
  assert.ok(cleanMerchant('#### 1234').length > 0)
})

test('known merchants: word-for-word lookup', () => {
  assert.equal(findKnown('blue bottle cof')?.category, 'coffee')
  assert.equal(findKnown('uber trip help')?.text, 'uber trip')
  assert.equal(findKnown('uber eats')?.category, 'eating_out')
  assert.equal(findKnown('target')?.category, 'shopping')
  assert.equal(findKnown('target optical center'), null, 'a whole-name entry must not match inside a longer name')
  assert.equal(findKnown('delta dental')?.category, 'health')
  assert.equal(findKnown('golden dragon noodle house'), null)
  assert.deepEqual(canonical('starbucks store'), {merchant: 'starbucks', label: null})
  assert.equal(canonical('amzn mktp us amzn').label, 'Amazon')
  assert.equal(canonical('some unknown shop').merchant, 'some unknown shop')
})

test('example bank: no duplicates, every entry usable', () => {
  const seen = new Set<string>()
  for (const e of BANK) {
    assert.ok(e.text.length >= 2 && e.text === e.text.toLowerCase(), e.text)
    const key = `${e.match === 'model' ? 'm' : 'k'}:${e.text}`
    assert.ok(!seen.has(key), `duplicate ${e.text}`)
    seen.add(key)
  }
  assert.ok(BANK.length > 800)
})

test('rules: fees, cash and money in need no model', () => {
  assert.equal(byRule('overdraft fee', 'OVERDRAFT FEE', -3400)?.category, 'fees')
  assert.equal(byRule('incoming wire transfer fee', 'INCOMING WIRE TRANSFER FEE', -1500)?.kind, 'wire fee')
  assert.equal(byRule('non-network atm fee', 'NON-NETWORK ATM FEE', -300)?.kind, 'ATM fee')
  assert.equal(byRule('planet fitness', 'PLANET FITNESS ANNUAL FEE', -4900)?.category, 'health', 'a merchant fee is not a bank fee')
  assert.equal(byRule('prometric test center exam fee', 'PROMETRIC TEST CENTER EXAM FEE', -9000), null)
  assert.equal(byRule('atm withdrawal', 'ATM WITHDRAWAL 004421', -6000)?.category, 'cash')
  assert.equal(byRule('acme payroll', 'ACME PAYROLL DIR DEP', 50000)?.kind, 'pay')
  assert.equal(byRule('netflix', 'NETFLIX REFUND', 1549)?.kind, 'refund')
})

test('classifier without the model: taught merchants win, unknown ones are honest', () => {
  const c = new Classifier(null)
  const before = c.classify('thinking cup', 'SQ *THINKING CUP', -500, null)
  assert.equal(before.category, 'other')
  assert.equal(before.confidence, 0)
  c.teach('thinking cup', 'coffee', null)
  const after = c.classify('thinking cup', 'SQ *THINKING CUP', -500, null)
  assert.equal(after.category, 'coffee')
  assert.equal(after.reason.how, 'taught')
  c.forget('thinking cup')
  assert.equal(c.classify('thinking cup', 'SQ *THINKING CUP', -500, null).category, 'other')
  assert.throws(() => new Classifier(new Float32Array(10)))
})

function analyseSample() {
  const imported = importStatement(sampleStatement())
  const classifier = new Classifier(null)
  const verdicts = imported.txns.map(t => classifier.classify(t.merchant, t.raw, t.amount, null))
  const summary = summarise(imported.txns, verdicts)
  const recurring = findRecurring(imported.txns, verdicts, summary.endDay)
  const alerts = findAlerts(imported.txns, verdicts, recurring, summary.startDay, summary.endDay)
  return {imported, verdicts, summary, recurring, alerts}
}

test('sample statement: the same every time, nothing skipped', () => {
  assert.equal(sampleStatement(), sampleStatement())
  const {imported, summary} = analyseSample()
  assert.ok(imported.txns.length > 300)
  assert.equal(imported.skipped.length, 0)
  assert.equal(summary.startDay, SAMPLE_START)
  assert.equal(summary.endDay, SAMPLE_END)
  assert.equal(summary.months.length, 6)
})

test('recurring: the planted subscriptions are found with the right rhythm and price', () => {
  const {recurring} = analyseSample()
  const by = new Map(recurring.map(r => [r.merchant, r]))
  for (const name of ['netflix', 'spotify', 'hulu', 'disney plus', 'apple bill', 'planet fitness', 'adobe', 'chegg', 'nytimes', 'amazon prime', 'comcast', 'mint mobile', 'eversource', 'mbta charlie']) {
    assert.ok(by.has(name), `${name} should be recurring`)
    assert.equal(by.get(name)!.cadence, 'monthly', name)
    assert.equal(by.get(name)!.active, true, name)
  }
  assert.equal(by.get('netflix')!.typical, 1799)
  assert.equal(by.get('netflix')!.yearly, 1799 * 12)
  assert.deepEqual(by.get('netflix')!.rise && [by.get('netflix')!.rise!.from, by.get('netflix')!.rise!.to], [1549, 1799])
  assert.equal(by.get('nytimes')!.rise?.to, 1700)
  assert.equal(by.get('spotify')!.rise, undefined)
  assert.equal(by.get('netflix')!.nextDay, toDay(2026, 11, 7))
  // Habits are not subscriptions.
  for (const name of ['starbucks', 'dunkin', 'chipotle', "trader joe's", 'uber trip', 'amzn mktp']) assert.ok(!by.has(name), `${name} is a habit, not a regular charge`)
  const soon = upcoming(recurring, SAMPLE_END)
  assert.ok(soon.length >= 14)
  assert.ok(soon.every(u => u.day > SAMPLE_END && u.day <= SAMPLE_END + 30))
  assert.ok(soon.every((u, i) => i === 0 || u.day >= soon[i - 1]!.day))
})

test('recurring: edge cases', () => {
  const make = (rows: [string, number][]) => importStatement('Date,Description,Amount\n' + rows.map(([d, a]) => `${d},ACME STREAMING,${a}`).join('\n'))
  const run = (rows: [string, number][]) => {
    const imp = make(rows)
    const c = new Classifier(null)
    c.teach('acme streaming', 'subscriptions', null)
    const verdicts = imp.txns.map(t => c.classify(t.merchant, t.raw, t.amount, null))
    return findRecurring(imp.txns, verdicts, imp.txns[imp.txns.length - 1]!.day)
  }
  assert.equal(run([['2026-01-05', -9.99]]).length, 0, 'one charge is not a pattern')
  assert.equal(run([['2026-01-05', -9.99], ['2026-02-05', -9.99]]).length, 1, 'two equal monthly charges are enough for a subscription')
  assert.equal(run([['2026-01-05', -9.99], ['2026-01-19', -42.5], ['2026-03-30', -3.1]]).length, 0, 'no rhythm, no pattern')
  const yearly = run([['2025-01-05', -99], ['2026-01-06', -99]])
  assert.equal(yearly[0]?.cadence, 'yearly')
  assert.equal(yearly[0]?.yearly, 9900)
  const skipped = run([['2026-01-05', -9.99], ['2026-02-05', -9.99], ['2026-04-05', -9.99], ['2026-05-05', -9.99]])
  assert.equal(skipped[0]?.cadence, 'monthly', 'one skipped month is forgiven')
  const weekly = run([['2026-01-05', -5], ['2026-01-12', -5], ['2026-01-19', -5], ['2026-01-26', -5]])
  assert.equal(weekly[0]?.yearly, 500 * 52)
  const lapsed = importStatement('Date,Description,Amount\n2026-01-05,ACME STREAMING,-9.99\n2026-02-05,ACME STREAMING,-9.99\n2026-03-05,ACME STREAMING,-9.99\n2026-08-01,OTHER SHOP,-5\n')
  const c = new Classifier(null)
  c.teach('acme streaming', 'subscriptions', null)
  const v = lapsed.txns.map(t => c.classify(t.merchant, t.raw, t.amount, null))
  assert.equal(findRecurring(lapsed.txns, v, toDay(2026, 8, 1))[0]?.active, false, 'a subscription that stopped is marked as stopped')
})

test('alerts: everything planted in the sample is caught, each with its lines', () => {
  const {alerts, imported} = analyseSample()
  const titles = alerts.map(a => `${a.kind}: ${a.title}`)
  const has = (kind: string, part: string) => assert.ok(alerts.some(a => a.kind === kind && a.title.includes(part)), `${kind} ${part} missing from\n${titles.join('\n')}`)
  has('duplicate', 'La Casa De Pedro')
  has('duplicate', 'Chegg')
  has('trial', 'Adobe')
  has('price_rise', 'Netflix')
  has('price_rise', 'Comcast')
  has('price_rise', 'New York Times')
  has('fee', 'wire fees')
  has('fee', 'account fees')
  has('fee', 'ATM fees')
  has('fee', 'foreign transaction fees')
  has('fee', 'overdraft fee')
  has('overlap', '3 video streaming')
  has('new_recurring', 'ChatGPT')
  assert.equal(alerts.filter(a => a.kind === 'duplicate').length, 2, 'two coffees in a day are not a duplicate')
  for (const a of alerts) {
    assert.ok(a.txnIds.length > 0, a.title)
    assert.ok(a.txnIds.every(id => imported.txns[id]), a.title)
    assert.ok(a.amount > 0, a.title)
  }
  const netflix = alerts.find(a => a.kind === 'price_rise' && a.title.includes('Netflix'))!
  assert.equal(netflix.yearly, 250 * 12)
  const wire = alerts.find(a => a.title.includes('wire fees'))!
  assert.equal(wire.amount, 9000)
  // Duplicates once, fees and rises at their yearly rate.
  const expected = alerts.reduce((sum, a) => sum + (a.kind === 'duplicate' ? a.amount : a.kind === 'fee' || a.kind === 'price_rise' ? a.yearly! : 0), 0)
  assert.equal(looseChange(alerts), expected)
  assert.ok(looseChange(alerts) > 50000)
})

test('summary: totals add up', () => {
  const {imported, verdicts, summary} = analyseSample()
  const out = imported.txns.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0)
  const into = imported.txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  assert.equal(summary.spent + summary.moved, out)
  assert.equal(summary.cameIn, into)
  assert.equal(summary.byCategory.reduce((s, c) => s + c.total, 0), summary.spent)
  let monthly = 0
  for (const m of summary.byMonth.values()) for (const v of m.values()) monthly += v
  assert.equal(monthly, summary.spent)
  assert.ok(verdicts.every(v => v.confidence >= 0 && v.confidence <= 1))
  assert.equal(summarise([], []).spent, 0)
})

test('questions: time ranges are read relative to the end of the statement', () => {
  const end = toDay(2026, 10, 31)
  const range = (q: string) => parseQuestion(q, end).range
  assert.deepEqual(range('how much on coffee last month'), {from: toDay(2026, 9, 1), to: toDay(2026, 9, 30), label: 'September 2026'})
  assert.deepEqual(range('coffee this month'), {from: toDay(2026, 10, 1), to: end, label: 'October 2026'})
  assert.deepEqual(range('uber in july'), {from: toDay(2026, 7, 1), to: toDay(2026, 7, 31), label: 'July 2026'})
  assert.deepEqual(range('rent in december'), {from: toDay(2025, 12, 1), to: toDay(2025, 12, 31), label: 'December 2025'})
  assert.equal(range('groceries in the last 3 months')!.from, toDay(2026, 8, 1))
  assert.equal(range('food in the last 30 days')!.from, end - 29)
  assert.equal(range('since august')!.from, toDay(2026, 8, 1))
  assert.equal(range('in 2026')!.to, toDay(2026, 12, 31))
  assert.equal(range('how much may i have spent on coffee'), null, '"may" as a verb is not a month')
  assert.equal(range('how much on coffee'), null)
})

test('questions: what is being asked', () => {
  const end = toDay(2026, 10, 31)
  assert.equal(parseQuestion('How much did I spend on coffee last month?', end).subject, 'coffee')
  assert.equal(parseQuestion('how many times did I use uber?', end).metric, 'count')
  assert.equal(parseQuestion('how many times did I use uber?', end).subject, 'uber')
  assert.equal(parseQuestion('what was my biggest purchase in July', end).metric, 'biggest')
  assert.equal(parseQuestion('what was my biggest purchase in July', end).fixed, 'everything')
  assert.equal(parseQuestion('average spent on eating out', end).metric, 'average')
  assert.equal(parseQuestion('how much did I spend in total?', end).fixed, 'everything')
  assert.equal(parseQuestion('how much did I pay in bank fees', end).fixed, 'fees')
  assert.equal(parseQuestion('what do my subscriptions cost', end).fixed, 'subscriptions')
  assert.equal(parseQuestion('how much did I earn', end).fixed, 'income')
  assert.equal(parseQuestion('', end).fixed, 'everything')
})

test('questions: answers are computed from the lines, and say which lines', () => {
  const {imported, verdicts, recurring} = analyseSample()
  const ask = (q: string) => {
    const parsed = parseQuestion(q, SAMPLE_END)
    const target = targetWithoutModel(parsed, imported.txns, recurring)
    assert.ok(target, `${q} should not need the model`)
    return answer(parsed, target, imported.txns, verdicts)
  }
  const netflix = ask('how much did I pay netflix?')
  assert.equal(netflix.text, '$100.44 for netflix in this statement.')
  assert.equal(netflix.txnIds.length, 6)
  assert.match(ask('how many times did I use uber in july?').text, /^\d+ payments? for uber trip in July 2026/)
  assert.match(ask('how much did I pay in bank fees?').text, /^\$217\.37 for bank fees/)
  assert.match(ask('biggest purchase in july').text, /\$1,150\.00 at Cedar Court Apartments on 1 Jul 2026/)
  assert.match(ask('how much did I earn?').text, /for money coming in/)
  assert.match(ask('how much on netflix in january').text, /^Nothing for netflix in January 2026/)
  const everything = ask('how much did I spend in total')
  assert.equal(everything.txnIds.length, imported.txns.filter(t => t.amount < 0 && verdicts[t.id]!.category !== 'transfers').length)
})
