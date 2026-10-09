// Coding-question speaker notes and test-case grading.
//
// SHARED SOURCE: the functions below are copied verbatim into the add-on
// (codekiwi-appscript/Code.js) and the frontend (src/testCases.js), so the
// sidebar writes exactly what the grader reads. Edit all three together, in
// plain ES5 (Apps Script).
//
// Note format. Everything after "Code Question:" up to the first marker is the
// prompt. Test cases follow, each an optional input and an expected output:
//
//   Code Question:
//   Read two numbers and print their sum.
//
//   Test Input:
//   5 7
//   Test Output:
//   12
//
//   Test Input:
//   -3 3
//   Test Output:
//   0
//
//   Grading: exact          <- optional; default ignores case and extra spaces
//
// The older single "Expected Output:" block is read as one test with no input.
// Markers must start a line, so the same words inside the prompt prose are
// left alone. A test with an empty expected output is ignored, and only the
// first CK_MAX_TESTS tests count (the executor runs at most that many).

var CK_MAX_TESTS = 10;
var CK_MARKER_RE = /^[^\S\n]*(expected output|test input|test output|grading)[^\S\n]*:[^\S\n]*/gim;

function ckBlock(text) {
  // Drop the newline after a marker line and any trailing blank lines/spaces.
  return text.replace(/^\n/, "").replace(/\s+$/, "");
}

/**
 * @returns {{ isCoding: boolean, prompt: string, tests: { input: string, output: string }[], lenient: boolean }}
 */
function parseCodingNote(note) {
  var empty = { isCoding: false, prompt: "", tests: [], lenient: true };
  if (typeof note !== "string" || !/^\s*code question:/i.test(note)) return empty;
  var body = note.replace(/^\s*code question:[^\S\n]*\n?/i, "");
  var marks = [];
  var m;
  CK_MARKER_RE.lastIndex = 0;
  while ((m = CK_MARKER_RE.exec(body)) !== null) {
    marks.push({ kind: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  var prompt = (marks.length ? body.slice(0, marks[0].start) : body).trim();
  var tests = [];
  var lenient = true;
  var pendingInput = null;
  for (var i = 0; i < marks.length; i++) {
    var content = ckBlock(body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : body.length));
    var kind = marks[i].kind;
    if (kind === "test input") {
      pendingInput = content;
    } else if (kind === "test output" || kind === "expected output") {
      if (content.trim() !== "" && tests.length < CK_MAX_TESTS) tests.push({ input: kind === "test output" && pendingInput ? pendingInput : "", output: content });
      pendingInput = null;
    } else if (kind === "grading") {
      if (/^exact\b/i.test(content.trim())) lenient = false;
    }
  }
  return { isCoding: true, prompt: prompt, tests: tests, lenient: lenient };
}

/** Write a coding note back out in the canonical format. */
function formatCodingNote(prompt, tests, lenient) {
  var out = "Code Question:\n" + String(prompt || "").trim();
  for (var i = 0; i < tests.length; i++) {
    var input = String(tests[i].input || "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
    var output = String(tests[i].output || "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
    if (output.trim() === "") continue;
    out += "\n\n";
    if (input.trim() !== "") out += "Test Input:\n" + input + "\n";
    out += "Test Output:\n" + output;
  }
  if (lenient === false) out += "\n\nGrading: exact";
  return out;
}

function ckLines(s, lenient) {
  var text = String(s == null ? "" : s);
  if (text.normalize) text = text.normalize("NFC"); // "é" typed vs composed
  var lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (var i = 0; i < lines.length; i++) {
    lines[i] = lenient ? lines[i].replace(/\s+/g, " ").trim().toLowerCase() : lines[i].replace(/\s+$/, "");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  while (lines.length && lines[0] === "") lines.shift();
  return lines;
}

/**
 * Does a program's output satisfy one test? The output must END with the
 * expected lines. Anything before them is ignored (earlier prompts or output),
 * and the first expected line may follow prompt text on the same line
 * ("Enter two numbers: 12"), since input isn't echoed into the output. Prompt
 * text means something ending in ":" or "?" (optionally followed by spaces),
 * or ">" followed by a space, so "Sum is 12" and ">12" still fail.
 */
function gradeTest(output, expected, lenient) {
  var out = ckLines(output, lenient);
  var exp = ckLines(expected, lenient);
  if (!exp.length || out.length < exp.length) return false;
  var tail = out.slice(out.length - exp.length);
  for (var i = 1; i < exp.length; i++) if (tail[i] !== exp[i]) return false;
  if (tail[0] === exp[0]) return true;
  var first = tail[0];
  if (first.length <= exp[0].length || first.slice(first.length - exp[0].length) !== exp[0]) return false;
  return /([:?]\s*|>\s+)$/.test(first.slice(0, first.length - exp[0].length));
}

/** Test input as a program should receive it: always newline-terminated. */
function testStdin(input) {
  var s = String(input || "").replace(/\r\n/g, "\n");
  return s === "" || s.charAt(s.length - 1) === "\n" ? s : s + "\n";
}

module.exports = { parseCodingNote, formatCodingNote, gradeTest, testStdin, CK_MAX_TESTS };
