# Loose Change

Drop in a bank statement. A small AI model reads it inside your browser tab and points out the
money that leaves quietly: forgotten subscriptions, prices that went up, double charges and bank fees.

Nothing is uploaded. The model is a 23 MB file that ships with the page and runs on your device.

## What it does

- **Reads any bank's CSV.** It works out which column is the date, the description and the amount,
  handles debit/credit columns, day-first dates, decimal commas, and card statements that list
  purchases as positive numbers.
- **Sorts every line into a category.** `POS DEBIT 0412 SQ *BLUE BOTTLE COF OAKLAND CA #2231`
  becomes "Blue Bottle Cof, Coffee & snacks". Known merchants are matched word for word; everything
  else is placed by a sentence-embedding model by meaning, so a noodle bar it has never heard of
  still lands in Eating out.
- **Finds regular charges by rhythm,** not from a list of names: anything that comes round weekly,
  monthly, quarterly or yearly at a steady price. It shows what each costs over a year and when the
  next one is due.
- **Raises alerts,** each with the exact lines behind it: charged twice, price went up, a $1 trial
  that became a paid plan, several subscriptions doing the same job, and every kind of bank fee
  added up to a yearly figure.
- **Says when it is unsure.** Low-confidence lines are put in front of you instead of guessed
  quietly. Correct one and it remembers on your device; merchants with similar names follow.
- **Answers plain questions** such as "how much went on food delivery since August?" by working out
  what you mean with the same model and adding up the matching lines.
- **Explains itself.** Every category has a "why": the known merchant it matched, the rule that
  fired, or the nearest examples the model found and how close they were.

## Privacy, and how to check it

- The page carries a Content Security Policy with `connect-src 'self'`, so the browser itself
  refuses any connection to another server. It is the first thing in `public/index.html`.
- The model, its WebAssembly runtime and the example vectors are served from the same address as
  the page. No CDN, no API, no key.
- Load the page, turn off your network, then open a statement. It still works. (The automated
  checks do exactly this.)
- The statement lives in the tab's memory only. The corrections you teach it are saved in
  `localStorage`, and "Start over" offers to forget them.

## How the AI part works

1. `src/core/clean.ts` strips what banks add around a merchant (terminal numbers, processors such as
   `SQ *`, phone numbers, city and state).
2. `src/core/bank.ts` holds about 930 labelled examples: merchant names and short descriptions of
   kinds of place ("espresso bar", "property management", "exam fee").
3. `npm run bank` embeds those once with **all-MiniLM-L6-v2** (384 dimensions, 8-bit quantised) and
   writes `public/bank.bin`.
4. In the browser the same model runs in a Web Worker through transformers.js and ONNX Runtime Web.
   Only merchants that no rule or known name settles are embedded, a dozen at a time, and the page
   repaints as answers arrive. Rules and known merchants show at once, so the page is useful before
   the model has finished and still useful if it cannot load.
5. `src/core/classify.ts` takes the six nearest examples, lets them vote (squared, so one close
   neighbour outweighs several loose ones; a brand name that merely looks similar counts for less
   than a description that is close in meaning), and turns the result into a confidence.
6. What you teach it is stored as another example with its own vector, so one correction also moves
   merchants whose names are close.

## Measured, not promised

`npm run accuracy` scores the classifier on two hand-labelled lists of statement lines.

| List | Lines | Right category |
| --- | --- | --- |
| Tuning list, merchants in the example bank | 79 | 100% |
| Tuning list, merchants it was never told about | 85 | 96.5% |
| **Held-out list, never used for tuning, all unknown merchants** | **73** | **90.4%** |

On the held-out list it said it was confident for 80.8% of lines and was right on 98.3% of those;
the rest it sent to the user to check. One bug in the name cleaner was found while reading the
held-out misses and fixed (it dropped the last word before a store number); the classifier itself
was not adjusted to that list. The lists are small, so read these as indications, not guarantees.

## Limits

- CSV only. PDF statements are not read.
- The example bank knows mostly US merchants and English descriptions; elsewhere more lines will be
  sent to you to check.
- A regular charge needs at least two or three cycles to be noticed, so a one-month statement shows
  few.
- It adds up what the statement says. It does not give financial advice.

## Run it

Needs Node 22.18 or newer.

```bash
npm install
npm run dev        # builds and serves http://localhost:5177
```

Other commands:

```bash
npm test           # type check and 23 unit tests
npm run qa         # 13 end-to-end browser scenarios (needs "npm run dev" running and "npm i -D playwright")
npm run accuracy   # the numbers in the table above
npm run bank       # re-embed the examples after editing src/core/bank.ts
npm run build      # the static site in public/, ready for any static host
```

The model files in `public/models/all-MiniLM-L6-v2/` come from
[Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (Apache-2.0):
`config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` and
`onnx/model_quantized.onnx`.

## Built with

TypeScript, transformers.js, ONNX Runtime Web (WebAssembly), all-MiniLM-L6-v2, esbuild, Node's test
runner, Playwright for the browser checks. No framework and no server: the whole app is static files.

## How it was made

Built for SLAY HACKS 2026 in November 2026 with help from Claude Code, an AI coding assistant. The
sample statement is invented; no real person's data is in this repository.
