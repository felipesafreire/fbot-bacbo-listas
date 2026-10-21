"use strict";

const assert = require("node:assert/strict");
const PatternGuard = require("../js/patterns.js");

function check(history, target, expectedAbort, expectedRule, config = {}) {
  const result = PatternGuard.evaluate(history, target, config);
  assert.equal(result.abort, expectedAbort, `${history.join("")} -> ${target}`);
  if (expectedRule) assert.equal(result.rule, expectedRule);
  return result;
}

check(["V", "V", "V", "V"], "A", true, "strong-sequence");
check(["V", "V", "V", "V"], "V", false);

check(["A", "V", "A", "V", "A"], "A", true, "alternating");
check(["A", "V", "A", "V", "A"], "V", false);
check(["V", "A", "V", "A", "V"], "V", true, "alternating");

check(["A", "A", "A", "V", "V"], "V", true, "majority-3x2");
check(["A", "A", "A", "V", "V"], "A", false);

check(["A", "A", "A", "A", "V"], "A", true, "recent-break");
check(["A", "A", "A", "A", "V"], "V", false);
check(["A", "A", "A", "A", "V", "V"], "A", true, "recent-break");

check(
  ["A", "A", "V", "V"],
  "V",
  true,
  "custom",
  {
    customPatterns: [
      { id: "custom-1", pattern: "AAVV", expected: "A", enabled: true },
    ],
  },
);

check(["A", "T", "A", "T", "A"], "V", true, "strong-sequence");
check(["V", "V", "V"], "A", false, null, { enabled: false });
check(["V", "V", "V"], "T", false);

assert.equal(
  PatternGuard.blocksOppositeSequence(["V", "V", "V"], "A")?.rule,
  "strong-sequence",
);
assert.equal(PatternGuard.blocksOppositeSequence(["V", "V", "V"], "V"), null);
assert.equal(PatternGuard.blocksOppositeSequence(["V", "V"], "A"), null);
assert.equal(
  PatternGuard.blocksOppositeSequence(["A", "V", "A", "V", "A"], "A"),
  null,
);

check(["V", "V", "V"], "A", false, null, {
  strongSequenceLength: 4,
  majorityThreeTwo: false,
});
check(["A", "A", "A", "A", "V", "V"], "V", true, "majority-3x2", {
  strongSequence: false,
  recentBreak: false,
  majorityWindow: 6,
  majorityCount: 4,
});
check(["A", "V", "A", "V", "A"], "A", false, null, {
  alternatingLength: 6,
  majorityThreeTwo: false,
});
check(["A", "A", "A", "A", "V"], "A", false, null, {
  recentBreakLength: 5,
  strongSequence: false,
  majorityThreeTwo: false,
});

console.log("PatternGuard: todos os cenários passaram.");
