// Dependency-free assertions for the autograder. Run with: npm test
// (node's built-in assert; no test framework needed).
const assert = require("assert");
const {
  parseCodingNote,
  gradeOutput,
  looksLikeError,
  normalizeOutput,
} = require("../src/services/grader");

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  passed++;
}

// ── parseCodingNote ──────────────────────────────────────────────────────────
check(
  "prompt + expected split",
  parseCodingNote("Code Question:\nPrint a happy face\n\nExpected Output:\n😊"),
  { isCoding: true, prompt: "Print a happy face", expected: "😊" }
);
check(
  "coding note with no expected block",
  parseCodingNote("Code Question:\nJust talk about loops"),
  { isCoding: true, prompt: "Just talk about loops", expected: null }
);
check("plain speaker note is not coding", parseCodingNote("I love it").isCoding, false);
check("non-string note is not coding", parseCodingNote(null).isCoding, false);
check(
  "marker matching is case-insensitive",
  parseCodingNote("code question:\nDo X\nexpected output:\nX").expected,
  "X"
);
check(
  "multi-line expected output is preserved",
  parseCodingNote("Code Question:\nPrint two lines\nExpected Output:\nhello\nworld").expected,
  "hello\nworld"
);
check(
  "'expected output' inside prompt prose does not split",
  parseCodingNote("Code Question:\nDescribe the expected output of a loop").expected,
  null
);

// ── gradeOutput ──────────────────────────────────────────────────────────────
check("exact match passes", gradeOutput("Slow down!", "Slow down!"), true);
check("trailing whitespace/newlines ignored", gradeOutput("Slow down!  \n\n", "Slow down!"), true);
check("leading blank lines ignored", gradeOutput("\n\nhi", "hi"), true);
check("multi-line match passes", gradeOutput("hello\nworld\n", "hello\nworld"), true);
check("wrong output fails", gradeOutput("Speed up!", "Slow down!"), false);
check("internal whitespace is significant", gradeOutput("a b", "a  b"), false);
check("CRLF normalizes to LF", gradeOutput("hello\r\nworld", "hello\nworld"), true);

// ── looksLikeError ───────────────────────────────────────────────────────────
check("traceback flagged", looksLikeError("Traceback (most recent call last):"), true);
check("SyntaxError flagged", looksLikeError("SyntaxError: invalid syntax"), true);
check("clean output not flagged", looksLikeError("42\n"), false);

// ── normalizeOutput ──────────────────────────────────────────────────────────
check("normalize strips edge blank lines + trailing spaces", normalizeOutput("\n a  \nb \n\n"), " a\nb");

console.log(`\n✅ grader: ${passed} assertions passed`);
