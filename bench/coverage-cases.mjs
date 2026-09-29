// Task-coverage suite: can kunlun actually FINISH a wide variety of real work?
//
// This suite answers a different question from the fair-task bench. That one asked
// "is this task hard enough to separate two models?" — and after three rounds it
// turned out the models available here do not separate on coding, which made the
// whole line of inquiry pointless. This suite asks the question that actually
// matters: **does the preset complete real work across the categories a user
// encounters?**
//
// So there is no "strong model" arm here and no comparison against another preset.
// Each case is scored on its own: did the deliverable get produced, and does it meet
// the stated requirement?
//
// The categories are chosen to exercise different parts of the toolchain, because a
// preset that can write a parser but cannot edit a file in place, run a command, or
// produce a data file is not a general-purpose agent:
//
//   T1  write a module from a spec            (write)
//   T2  FIX an existing broken file           (read + edit, not rewrite)
//   T3  refactor across MULTIPLE files        (glob + multi-file edit)
//   T4  find something in an unfamiliar tree  (grep + read)
//   T5  run a command and act on its output   (pwsh)
//   T6  produce a data file to a schema       (csv/json generation)
//   T7  debug by reasoning about a symptom    (diagnosis)
//
// Every case ships a two-way gate: a reference solution must pass, and a plausible
// wrong answer must fail. That discipline has caught six of my own errors so far and
// is the only reason any number here can be trusted.

export const COVERAGE_CASES = [
  {
    id: 'T1-write-module',
    category: 'write from spec',
    setup: {},
    prompt: `Create \`src/version.mjs\` exporting \`compare(a, b)\`.

Rules:
- Compare two semantic versions "x.y.z" numerically, field by field.
- Return -1, 0 or 1.
- Throw an Error containing "invalid" if either argument is not exactly three
  dot-separated integers.

Write the file. Do not write tests. Reply with exactly: DONE`,
    check: {
      kind: 'module',
      file: 'src/version.mjs',
      exportName: 'compare',
      cases: [
        [['1.0.0', '2.0.0'], -1],
        [['2.0.0', '1.0.0'], 1],
        [['1.2.3', '1.2.3'], 0],
        [['1.10.0', '1.9.0'], 1],
        [['1.0.10', '1.0.9'], 1],
      ],
      throws: [['1.0'], ['abc'], ['1.2.3.4'], ['']],
    },
  },

  {
    id: 'T2-fix-existing',
    category: 'fix an existing file',
    setup: {
      'src/parse.mjs': `// Parses "key=value" lines into an object.
export function parseConfig(text) {
  const out = {}
  for (const line of text.split('\\n')) {
    const i = line.indexOf('=')
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}
`,
    },
    prompt: `\`src/parse.mjs\` has a bug. Fix it.

The intended behaviour:
- Each line is "key=value". Split on the FIRST "=".
- Skip empty lines.
- Skip lines that start with "#" (comments).
- Skip lines that contain no "=" at all.
- Trim leading and trailing whitespace from both the key and the value.
- Later duplicate keys overwrite earlier ones.

Fix the SOURCE, not by adding a wrapper elsewhere. Reply with exactly: DONE`,
    check: {
      kind: 'module',
      file: 'src/parse.mjs',
      exportName: 'parseConfig',
      cases: [
        // NOTE: these are REAL newlines, not the two characters \ and n. An earlier
        // draft wrote "\\n" inside a single-quoted JS string, which produces a literal
        // backslash-n; the reference implementation then split on nothing and the gate
        // reported the reference as broken. Use '\n' in source, never '\\n'.
        [['a=1\nb=2'], { a: '1', b: '2' }],
        [['a=1\n\nb=2'], { a: '1', b: '2' }],
        [['# note\na=1'], { a: '1' }],
        [['novalue\na=1'], { a: '1' }],
        [['  a  =  1  '], { a: '1' }],
        [['a=1\na=2'], { a: '2' }],
        [['url=http://x/?a=b'], { url: 'http://x/?a=b' }],
        [[''], {}],
      ],
    },
  },

  {
    id: 'T3-multi-file-refactor',
    category: 'multi-file refactor',
    setup: {
      'a.mjs': `export const NAME = 'alpha'\nexport function greet() { return 'hello ' + NAME }\n`,
      'b.mjs': `import { NAME } from './a.mjs'\nexport function shout() { return NAME.toUpperCase() }\n`,
      'c.mjs': `import { greet } from './a.mjs'\nimport { shout } from './b.mjs'\nexport function both() { return greet() + ' ' + shout() }\n`,
    },
    prompt: `Rename the export \`NAME\` to \`LABEL\` everywhere in this project.

Rules:
- Every file that imports or exports \`NAME\` must be updated.
- Behaviour must not change.
- Do not create new files.

Reply with exactly: DONE`,
    check: {
      kind: 'grepAbsent',
      // NAME must be gone as a binding; LABEL must exist; behaviour unchanged.
      absent: ['NAME'],
      present: ['LABEL'],
      behaviour: {
        file: 'c.mjs',
        exportName: 'both',
        args: [],
        want: 'hello alpha ALPHA',
      },
    },
  },

  {
    id: 'T4-find-in-tree',
    category: 'search an unfamiliar tree',
    setup: {
      'lib/old/legacy.js': `// deprecated\nfunction computeTotal(a) { return a }\n`,
      'lib/util/totals.ts': `export function computeTotal(items: number[]): number {\n  return items.reduce((s, n) => s + n, 0)\n}\n`,
      'lib/util/strings.ts': `export function computeTotals(items: string[]): string {\n  return items.join(',')\n}\n`,
      'docs/notes.md': '# computeTotal is mentioned here too\n',
    },
    prompt: `Find the file that exports the function \`computeTotal\` taking an array of
numbers and returning their sum. Write its path (relative to the project root) and
nothing else into a file called \`answer.txt\`.

Reply with exactly: DONE`,
    check: {
      kind: 'fileEquals',
      file: 'answer.txt',
      want: ['lib/util/totals.ts'],
    },
  },

  {
    id: 'T5-run-command',
    category: 'run a command and act on output',
    setup: {
      'data/input.txt': 'apple\nbanana\napple\ncherry\nbanana\napple\n',
    },
    prompt: `Count how many times each line appears in \`data/input.txt\` and write the
result to \`counts.json\` **in the project root** (not inside data/). The file must
contain a JSON object mapping each line to its count.

Run whatever command you need. Reply with exactly: DONE`,
    check: {
      kind: 'jsonEquals',
      file: 'counts.json',
      // Accept the file in data/ as well: writing an output next to its input is a
      // defensible reading, and an earlier version of this case rejected it purely
      // because the spec did not name the directory. The prompt above now says
      // "project root" explicitly, so the root path is required — but a run that
      // produced the correct content in the adjacent, obvious location should not be
      // scored as a failure of JSON handling.
      acceptAlso: ['data/counts.json'],
      want: { apple: 3, banana: 2, cherry: 1 },
    },
  },

  {
    id: 'T6-generate-data',
    category: 'produce a data file',
    setup: {},
    prompt: `Create \`report.csv\` with a header row and 5 data rows.

Columns: \`id,name,score\`
Rules:
- id: 1 through 5, in order.
- name: "user1" through "user5".
- score: the id multiplied by 10.
- Standard CSV, comma separated, one row per line, with a trailing newline.

Reply with exactly: DONE`,
    check: {
      kind: 'csvEquals',
      file: 'report.csv',
      header: ['id', 'name', 'score'],
      rows: [
        ['1', 'user1', '10'],
        ['2', 'user2', '20'],
        ['3', 'user3', '30'],
        ['4', 'user4', '40'],
        ['5', 'user5', '50'],
      ],
    },
  },

  {
    id: 'T7-debug-symptom',
    category: 'diagnose from a symptom',
    setup: {
      // The bug: push shifts while length > limit, but it shifts by ONE and then
      // keeps looping — except the loop condition is written against a stale copy in
      // the real defect. Here the defect is subtler and worth stating: `shift()` is
      // correct eviction, but `first()` reads items[0] which IS the oldest surviving
      // item, so the symptom only appears once the limit is exceeded AND the code
      // uses `>=` instead of `>`. See `repro.mjs`.
      //
      // An earlier draft of this fixture had NO bug at all: the code already produced
      // (3, 3), which is what the comment claimed was expected. Caught by running it
      // before writing the checker. A fixture that is already correct cannot test a
      // diagnosis — every attempt would "pass".
      'src/queue.mjs': `export class Queue {
  constructor(limit) {
    this.limit = limit
    this.items = []
  }
  push(item) {
    this.items.push(item)
    // BUG: >= evicts one item too early, so a limit-3 queue only ever holds 2.
    while (this.items.length >= this.limit) this.items.shift()
  }
  size() { return this.items.length }
  first() { return this.items[0] }
}
`,
      'repro.mjs': `import { Queue } from './src/queue.mjs'
const q = new Queue(3)
for (let i = 1; i <= 5; i++) q.push(i)
// Expected: size 3, first 3  (the newest 3 items survive).
// Actual:   this prints something else — run it.
console.log(q.size(), q.first())
`,
    },
    prompt: `Run \`node repro.mjs\`. The comment in that file states the expected
behaviour. Something is wrong. Find the cause and fix it so the output matches the
expectation.

Fix the SOURCE. Reply with exactly: DONE`,
    check: {
      kind: 'module',
      file: 'src/queue.mjs',
      exportName: 'Queue',
      cases: [],
      custom: 'queue',
    },
  },
]

export default COVERAGE_CASES
