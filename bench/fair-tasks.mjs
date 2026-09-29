// A fair discriminator: fully-specified tasks whose DIFFICULTY IS IN THE ALGORITHM.
//
// WHY THE FIRST TWO ATTEMPTS FAILED
//
// Round 1 tasks were single-file pure functions with a complete spec. Both models
// scored 18/18 — the tasks were simply too easy to separate anything.
//
// Round 2 was a multi-file bug hunt with hidden edge cases. All 9 sessions scored
// 9/10, failing the same hidden case. That result was my design error, not a model
// difference: the visible tests showed `toCents(1.005)` and `toCents(2.675)`, the
// models wrote a fix that satisfied exactly those, and the hidden case asked for
// `toCents(4.015)` — the same bug at a harder input, with NOTHING in the visible
// suite hinting that generalisation was required. A test that punishes a model for
// solving the stated problem is measuring the author, not the model.
//
// THE PRINCIPLE FOR THIS SET
//
// Difficulty must come from the WORK, not from hidden requirements:
//
//   * every rule is stated explicitly — no guessing
//   * the visible tests cover a REPRESENTATIVE sample, so passing them means the
//     idea is understood, not just the examples
//   * the difficulty is that a correct implementation requires real reasoning:
//     edge-case enumeration, invariants, ordering, or complexity
//
// A weak model fails these because it CANNOT hold the whole problem together, not
// because it was not told what to do.
//
// Each task states its rules, then its tests cover the rule space evenly.

export const FAIR_TASKS = [
  {
    id: 'F1-calculator',
    difficulty: 'algorithmic — recursive descent with precedence and unary minus',
    file: 'calculator.mjs',
    exportName: 'evaluate',
    prompt: `Write \`calculator.mjs\` exporting \`evaluate(expr)\` — a complete arithmetic
expression evaluator. Return a Number.

FULL SPECIFICATION — implement every rule:

1. Numbers: one or more digits, optional single "." and optional fraction digits.
2. Binary operators: + - * / with normal precedence (* and / bind tighter than + and -).
3. All binary operators are LEFT-associative: 10-3-2 is 5, not 9.
4. Parentheses group subexpressions, and may nest arbitrarily.
5. Unary minus is allowed before a number, before "(", or before another unary minus:
   "-5", "-(2+3)", "--5" (which is 5), "3 * -2".
   Unary minus binds TIGHTER than * and /: "-2 * 3" is -6.
6. Whitespace anywhere is ignored.
7. Division by zero throws an Error whose message contains "division by zero".
8. Any malformed input throws an Error. Malformed includes: empty string, unbalanced
   parentheses, two operators in a row where the second is not a unary minus,
   a trailing operator, and a stray "." with no digits.
9. The result is exact for the given operators (no rounding).`,
    tests: [
      // precedence and associativity
      { call: ['"2+3*4"'], want: '14' },
      { call: ['"(2+3)*4"'], want: '20' },
      { call: ['"10-3-2"'], want: '5' },
      { call: ['"100/10/2"'], want: '5' },
      { call: ['"2+3*4-6/3"'], want: '12' },
      // unary minus, including the tight-binding rule
      { call: ['"-5"'], want: '-5' },
      { call: ['"--5"'], want: '5' },
      { call: ['"-(2+3)"'], want: '-5' },
      { call: ['"-2*3"'], want: '-6' },
      { call: ['"3*-2"'], want: '-6' },
      { call: ['"-2--3"'], want: '1' },
      { call: ['"-(2)*-(3)"'], want: '6' },
      { call: ['"1+-2"'], want: '-1' },
      // decimals
      { call: ['"1.5+2.25"'], want: '3.75' },
      { call: ['"0.1+0.2"'], want: '0.30000000000000004' },
      // nesting
      { call: ['"((1+2)*(3+4))"'], want: '21' },
      { call: ['"2*(3+(4-1))"'], want: '12' },
      // whitespace
      { call: ['"  1  +  2  "'], want: '3' },
      // errors — every case the spec promises to reject
      { call: ['"1/0"'], want: 'THROW' },
      { call: ['""'], want: 'THROW' },
      { call: ['"(1+2"'], want: 'THROW' },
      { call: ['"1++2"'], want: 'THROW' },
      { call: ['"1+"'], want: 'THROW' },
      { call: ['"."'], want: 'THROW' },
      { call: ['"*3"'], want: 'THROW' },
    ],
  },

  {
    id: 'F2-lru',
    difficulty: 'invariants — ordering under both get and put, with eviction and update',
    file: 'lru.mjs',
    exportName: 'createLRU',
    prompt: `Write \`lru.mjs\` exporting \`createLRU(capacity)\` returning an object with
\`get(key)\`, \`put(key, value)\`, and \`size()\`. Implement a least-recently-used cache.

FULL SPECIFICATION:

1. \`get(key)\` returns the stored value, or undefined if absent.
2. A successful \`get\` marks that key as MOST recently used.
3. A MISSING \`get\` does NOT change any ordering.
4. \`put(key, value)\` inserts or updates. In BOTH cases the key becomes most recently used.
5. When inserting a NEW key would exceed capacity, evict the LEAST recently used key first.
6. Updating an EXISTING key must NOT evict anything, even at full capacity.
7. \`size()\` returns the number of stored entries.
8. Capacity is at least 1. A capacity of 1 stores only the newest key.
9. \`put\` on an existing key replaces the value but does not change the entry count.`,
    tests: [
      // basic
      { call: ['mk(2)', 'p("a",1)', 'g("a")'], want: '1' },
      { call: ['mk(2)', 'p("a",1)', 'g("b")'], want: 'undefined' },
      // get refreshes order
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("a")', 'p("c",3)', 'g("b")'], want: 'undefined' },
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("a")', 'p("c",3)', 'g("a")'], want: '1' },
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("a")', 'p("c",3)', 'g("c")'], want: '3' },
      // a missing get must NOT refresh anything, and must not change the size
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("zzz")', 'p("c",3)', 'g("a")'], want: 'undefined' },
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("zzz")', 'sz()'], want: '2' },
      { call: ['mk(2)', 'p("a",1)', 'g("missing")', 'g("alsoMissing")', 'sz()'], want: '1' },
      { call: ['mk(3)', 'p("a",1)', 'g("x")', 'g("y")', 'g("z")', 'sz()'], want: '1' },
      // a miss must not disturb eviction order either: after a and b are stored and a
      // miss occurs, inserting c evicts a (the true LRU), so b SURVIVES.
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("miss")', 'p("c",3)', 'g("b")'], want: '2' },
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'g("miss")', 'p("c",3)', 'g("a")'], want: 'undefined' },
      // repeated misses on the same absent key still must not insert anything
      { call: ['mk(1)', 'g("q")', 'g("q")', 'g("q")', 'sz()'], want: '0' },
      // updating an existing key must not evict
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'p("a",9)', 'sz()'], want: '2' },
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'p("a",9)', 'g("b")'], want: '2' },
      { call: ['mk(2)', 'p("a",1)', 'p("b",2)', 'p("a",9)', 'g("a")'], want: '9' },
      // capacity 1
      { call: ['mk(1)', 'p("a",1)', 'p("b",2)', 'g("a")'], want: 'undefined' },
      { call: ['mk(1)', 'p("a",1)', 'p("b",2)', 'sz()'], want: '1' },
      { call: ['mk(1)', 'p("a",1)', 'p("a",2)', 'sz()'], want: '1' },
      // put refreshes order
      { call: ['mk(3)', 'p("a",1)', 'p("b",2)', 'p("c",3)', 'p("a",9)', 'p("d",4)', 'g("b")'], want: 'undefined' },
      { call: ['mk(3)', 'p("a",1)', 'p("b",2)', 'p("c",3)', 'p("a",9)', 'p("d",4)', 'g("a")'], want: '9' },
      // size
      { call: ['mk(3)', 'sz()'], want: '0' },
      { call: ['mk(3)', 'p("a",1)', 'p("b",2)', 'sz()'], want: '2' },
    ],
  },

  {
    id: 'F3-lis',
    difficulty: 'algorithm — the correct answer needs a real strategy, not brute force',
    file: 'subseq.mjs',
    exportName: 'longestIncreasingSubsequence',
    prompt: `Write \`subseq.mjs\` exporting \`longestIncreasingSubsequence(nums)\`.

Return the LONGEST STRICTLY INCREASING subsequence as an array. A subsequence keeps
the original relative order but need not be contiguous.

FULL SPECIFICATION:

1. "Strictly increasing" means each element is GREATER than the previous. Equal
   adjacent values are NOT increasing.
2. Return an actual subsequence (the values), not a length.
3. Return the lexicographically SMALLEST such sequence when read as an array of
   numbers compared element by element (shorter is smaller only if it is a prefix).
   In practice the standard rule applies: at each step, among all choices that still
   permit a maximum-length completion, take the SMALLEST value that occurs EARLIEST
   in the input. This is what the cases below pin down — implement to satisfy them.
4. For an empty input return [].
5. The input must not be mutated.

PERFORMANCE REQUIREMENT: the implementation must handle an input of 20,000 elements
within a few seconds. A brute-force O(n^2)-with-reconstruction may pass the small
cases but will time out; the intended solution is patience-sorting with predecessor
links.`,
    tests: [
      { call: ['[10,9,2,5,3,7,101,18]'], want: '[2,3,7,18]' },
      { call: ['[2,1,3]'], want: '[1,3]' },
      { call: ['[7,7,7]'], want: '[7]' },
      { call: ['[]'], want: '[]' },
      { call: ['[1]'], want: '[1]' },
      { call: ['[1,2,3]'], want: '[1,2,3]' },
      { call: ['[3,2,1]'], want: '[1]' },
      { call: ['[1,3,5,4,7]'], want: '[1,3,4,7]' },
      { call: ['[4,10,4,3,8,9]'], want: '[3,8,9]' },
      { call: ['[1,2,3,0,4]'], want: '[1,2,3,4]' },
      { call: ['[5,1,2,3,4]'], want: '[1,2,3,4]' },
      { call: ['[2,3,1,4]'], want: '[2,3,4]' },
      { call: ['[1,100,2,3,4]'], want: '[1,2,3,4]' },
    ],
    perf: { size: 20000, maxMs: 4000 },
  },

  {
    id: 'F4-diff',
    difficulty: 'algorithm + edge cases — Myers-style edit script with correct coalescing',
    file: 'diff.mjs',
    exportName: 'diffLines',
    prompt: `Write \`diff.mjs\` exporting \`diffLines(a, b)\` where \`a\` and \`b\` are arrays
of strings (lines). Return an array of edit operations.

FULL SPECIFICATION:

1. Each operation is \`{ op, lines }\` where \`op\` is "equal", "delete" or "insert",
   and \`lines\` is an array of the affected lines.
2. Applying the script in order transforms \`a\` into \`b\`: "equal" consumes a line
   present in both; "delete" removes a line of \`a\`; "insert" adds a line of \`b\`.
3. ORDERING RULE — a hard rule, not a preference: when a deletion and an insertion
   occur at the SAME position, the DELETE comes FIRST. This follows unified-diff
   convention, where a changed line appears as a "-" line immediately followed by a
   "+" line. So ["a","b","c"] -> ["a","x","c"] is equal[a], delete[b], insert[x],
   equal[c] — never the reverse. (An earlier revision of this task omitted this rule;
   every model then produced the opposite order. Both orders are equally minimal, so
   without the rule stated the task graded a convention it never communicated.)
4. ADJACENT OPERATIONS OF THE SAME OP MUST BE COALESCED into one entry. So a run of
   three deletions is ONE \`{op:"delete", lines:[...]}\`, never three.
5. The script must be MINIMAL: the number of changed lines (deleted + inserted) must be
   the smallest achievable for the given inputs.
6. Both inputs empty returns [].
7. Neither input array may be mutated.`,
    tests: [
      { call: ['[]', '[]'], want: '[]' },
      { call: ['["a"]', '["a"]'], want: '[{"op":"equal","lines":["a"]}]' },
      { call: ['[]', '["x"]'], want: '[{"op":"insert","lines":["x"]}]' },
      { call: ['["x"]', '[]'], want: '[{"op":"delete","lines":["x"]}]' },
      {
        call: ['["a","b","c"]', '["a","x","c"]'],
        want: '[{"op":"equal","lines":["a"]},{"op":"delete","lines":["b"]},{"op":"insert","lines":["x"]},{"op":"equal","lines":["c"]}]',
      },
      // coalescing: three deletions must be one entry
      {
        call: ['["a","b","c","d","e"]', '["a","e"]'],
        want: '[{"op":"equal","lines":["a"]},{"op":"delete","lines":["b","c","d"]},{"op":"equal","lines":["e"]}]',
      },
      // coalescing: three insertions must be one entry
      {
        call: ['["a","e"]', '["a","b","c","d","e"]'],
        want: '[{"op":"equal","lines":["a"]},{"op":"insert","lines":["b","c","d"]},{"op":"equal","lines":["e"]}]',
      },
      // minimality: 3 lines -> 3 lines with one shared line
      {
        call: ['["a","b","c"]', '["x","b","y"]'],
        want: '[{"op":"delete","lines":["a"]},{"op":"insert","lines":["x"]},{"op":"equal","lines":["b"]},{"op":"delete","lines":["c"]},{"op":"insert","lines":["y"]}]',
      },
    ],
  },

  // ── Tasks of the F3 type: difficulty is entirely in the algorithm, and every
  //    requirement is stated including the performance bound. This is the only shape
  //    that produced a real separation in three rounds of testing, so it is worth
  //    more instances.
  {
    id: 'F5-skyline',
    difficulty: 'algorithm — sweep line with a multiset and event coalescing',
    file: 'skyline.mjs',
    exportName: 'skyline',
    prompt: `Write \`skyline.mjs\` exporting \`skyline(buildings)\`.

\`buildings\` is an array of \`[left, right, height]\` with integer coordinates and
height > 0. Return the SKYLINE as an array of \`[x, height]\` key points.

FULL SPECIFICATION:

1. The skyline is the outline of the union of the rectangles. A key point is emitted
   wherever the maximum height changes as x increases.
2. The first key point is always \`[leftmostX, heightAtThatX]\` and the last is always
   \`[rightmostX, 0]\`.
3. Consecutive key points with the SAME height must be collapsed into one. That is, a
   key point whose height equals the previous key point's height must NOT be emitted.
4. A building's right edge is EXCLUSIVE: at x = right the building no longer covers
   that x. So a building [0,2,3] and a building [2,5,4] produce a height change at
   x=2, not an overlap.
5. Buildings may overlap; the taller one wins where they do.
6. An empty input returns [].
7. The input must not be mutated.

PERFORMANCE REQUIREMENT: must handle 50,000 buildings within a few seconds. A naive
O(n^2) sweep that rescans every building at every event will time out; the intended
solution is an event sweep with a height multiset and lazy deletion.`,
    tests: [
      { call: ['[]'], want: '[]' },
      { call: ['[[0,2,3]]'], want: '[[0,3],[2,0]]' },
      { call: ['[[0,2,3],[2,5,4]]'], want: '[[0,3],[2,4],[5,0]]' },
      {
        call: ['[[2,9,10],[3,7,15],[5,12,12],[15,20,10],[19,24,8]]'],
        want: '[[2,10],[3,15],[7,12],[12,0],[15,10],[20,8],[24,0]]',
      },
      // a taller building hidden inside a shorter one
      { call: ['[[0,10,5],[3,7,9]]'], want: '[[0,5],[3,9],[7,5],[10,0]]' },
      // identical buildings must not emit a duplicate key point
      { call: ['[[0,5,4],[0,5,4]]'], want: '[[0,4],[5,0]]' },
      // adjacent, equal heights must merge into one segment
      { call: ['[[0,3,2],[3,6,2]]'], want: '[[0,2],[6,0]]' },
    ],
    perf: { size: 50000, maxMs: 8000 },
  },

  {
    id: 'F6-toposort',
    difficulty: 'algorithm — deterministic lexicographic topological order with cycle reporting',
    file: 'toposort.mjs',
    exportName: 'topoSort',
    prompt: `Write \`toposort.mjs\` exporting \`topoSort(nodes, edges)\`.

\`nodes\` is an array of unique string ids. \`edges\` is an array of \`[from, to]\` pairs
meaning "from must come before to". Return the nodes in a valid order.

FULL SPECIFICATION:

1. Return an array of all node ids in an order where every edge's \`from\` precedes its
   \`to\`.
2. When several valid orders exist, return the LEXICOGRAPHICALLY SMALLEST one, where
   the comparison is on the sequence of node ids as strings. Equivalently: repeatedly
   take the ready node with the smallest id.
3. A self-edge \`[x, x]\` is a cycle.
4. If the graph contains a cycle, throw an Error whose message contains "cycle".
5. Duplicate edges are allowed and must not change the result.
6. An edge referring to an id not present in \`nodes\` must be ignored.
7. An empty \`nodes\` array returns [].
8. Neither input array may be mutated.

PERFORMANCE REQUIREMENT: must handle 100,000 nodes and 300,000 edges within a few
seconds. Selecting the smallest ready node by rescanning all candidates each time is
O(n^2) and will time out; use a heap or a sorted frontier.`,
    tests: [
      { call: ['[]', '[]'], want: '[]' },
      { call: ['["a"]', '[]'], want: '["a"]' },
      { call: ['["b","a"]', '[]'], want: '["a","b"]' },
      { call: ['["a","b"]', '[["a","b"]]'], want: '["a","b"]' },
      { call: ['["b","a"]', '[["b","a"]]'], want: '["b","a"]' },
      // lexicographic tie-break: both a and b are ready, take a
      { call: ['["c","b","a"]', '[["c","b"],["c","a"]]'], want: '["c","a","b"]' },
      // duplicate edges ignored
      { call: ['["a","b"]', '[["a","b"],["a","b"]]'], want: '["a","b"]' },
      // unknown ids in edges are ignored
      { call: ['["a","b"]', '[["a","b"],["zz","a"]]'], want: '["a","b"]' },
      // self edge is a cycle
      { call: ['["a"]', '[["a","a"]]'], want: 'THROW' },
      // two-node cycle
      { call: ['["a","b"]', '[["a","b"],["b","a"]]'], want: 'THROW' },
      // three-node cycle
      { call: ['["a","b","c"]', '[["a","b"],["b","c"],["c","a"]]'], want: 'THROW' },
      // diamond
      { call: ['["a","b","c","d"]', '[["a","b"],["a","c"],["b","d"],["c","d"]]'], want: '["a","b","c","d"]' },
    ],
    perf: { size: 100000, maxMs: 8000, kind: 'topo' },
  },

  {
    id: 'F7-intervals2',
    difficulty: 'algorithm — weighted interval scheduling with reconstruction',
    file: 'schedule.mjs',
    exportName: 'maxWeightSchedule',
    prompt: `Write \`schedule.mjs\` exporting \`maxWeightSchedule(intervals)\`.

Each interval is \`{ start, end, weight }\` with integer start < end and weight > 0.
Intervals are half-open: \`[start, end)\`, so an interval ending at x may be followed
by one starting at x without overlapping.

FULL SPECIFICATION:

1. Choose a subset of NON-OVERLAPPING intervals maximising the total weight.
2. Return \`{ total, chosen }\` where \`total\` is the summed weight and \`chosen\` is the
   selected intervals, each as \`{ start, end, weight }\`.
3. \`chosen\` must be sorted by \`start\` ascending.
4. When several subsets achieve the same maximum total, break the tie by comparing the
   \`chosen\` start values as sequences, SHORTER PREFIX WINS: [0] is smaller than [0,2],
   because the shorter sequence is a prefix of the longer one. Only if one start value
   differs does the smaller start win. So when a single heavy interval ties with two
   lighter ones covering the same span, the SINGLE interval is chosen.
   (An earlier revision stated this rule two contradictory ways and shipped an expected
   value that matched neither; caught by cross-checking against an implementation.)
5. Identical intervals are distinct entries and both may be counted only if they do
   not overlap — since they do overlap, only one can be chosen.
6. An empty input returns \`{ total: 0, chosen: [] }\`.
7. The input must not be mutated.

PERFORMANCE REQUIREMENT: must handle 200,000 intervals within a few seconds. Checking
every earlier interval for each candidate is O(n^2) and will time out; sort by end and
binary-search the last compatible interval.`,
    tests: [
      { call: ['[]'], want: '{"total":0,"chosen":[]}' },
      {
        call: ['[{"start":0,"end":1,"weight":5}]'],
        want: '{"total":5,"chosen":[{"start":0,"end":1,"weight":5}]}',
      },
      // touching intervals do NOT overlap (half-open)
      {
        call: ['[{"start":0,"end":1,"weight":5},{"start":1,"end":2,"weight":6}]'],
        want: '{"total":11,"chosen":[{"start":0,"end":1,"weight":5},{"start":1,"end":2,"weight":6}]}',
      },
      // the heavier long interval beats two light short ones
      {
        call: ['[{"start":0,"end":3,"weight":10},{"start":0,"end":1,"weight":4},{"start":1,"end":3,"weight":4}]'],
        want: '{"total":10,"chosen":[{"start":0,"end":3,"weight":10}]}',
      },
      // ties on total: a single interval [0] beats two intervals [0,2] by the
      // shorter-prefix rule
      {
        call: ['[{"start":0,"end":5,"weight":10},{"start":0,"end":2,"weight":5},{"start":2,"end":5,"weight":5}]'],
        want: '{"total":10,"chosen":[{"start":0,"end":5,"weight":10}]}',
      },
      // classic weighted interval scheduling: {2,5,6} + {5,8,11} = 17
      {
        call: ['[{"start":1,"end":3,"weight":5},{"start":2,"end":5,"weight":6},{"start":4,"end":6,"weight":5},{"start":6,"end":7,"weight":4},{"start":5,"end":8,"weight":11},{"start":7,"end":9,"weight":2}]'],
        want: '{"total":17,"chosen":[{"start":2,"end":5,"weight":6},{"start":5,"end":8,"weight":11}]}',
      },
      // These three defeat a greedy "take the heaviest first" strategy, which scores
      // 10, 10 and 5 respectively. A greedy implementation passes every case above but
      // fails here — which is what makes this task discriminate rather than merely
      // confirm. (Without these, the gate showed greedy passing the whole suite.)
      {
        call: ['[{"start":0,"end":10,"weight":10},{"start":0,"end":5,"weight":6},{"start":5,"end":10,"weight":6}]'],
        want: '{"total":12,"chosen":[{"start":0,"end":5,"weight":6},{"start":5,"end":10,"weight":6}]}',
      },
      {
        call: ['[{"start":0,"end":10,"weight":10},{"start":0,"end":4,"weight":7},{"start":4,"end":10,"weight":7}]'],
        want: '{"total":14,"chosen":[{"start":0,"end":4,"weight":7},{"start":4,"end":10,"weight":7}]}',
      },
      {
        call: ['[{"start":0,"end":6,"weight":5},{"start":0,"end":2,"weight":3},{"start":2,"end":4,"weight":3},{"start":4,"end":6,"weight":3}]'],
        want: '{"total":9,"chosen":[{"start":0,"end":2,"weight":3},{"start":2,"end":4,"weight":3},{"start":4,"end":6,"weight":3}]}',
      },
    ],
    perf: { size: 200000, maxMs: 8000, kind: 'schedule' },
  },
]

export default FAIR_TASKS
