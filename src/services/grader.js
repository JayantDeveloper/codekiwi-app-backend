// Autograding for coding-question slides.
//
// A coding slide is authored in its speaker notes with the existing
// "Code Question:" marker. To make it auto-gradable, the teacher adds an
// "Expected Output:" block below the prompt, e.g.
//
//   Code Question:
//   Print a happy face emoji
//
//   Expected Output:
//   😊
//
// Everything after "Expected Output:" is the expected program stdout. When a
// student runs code on that slide, we compare the (normalized) program output
// to the expected block and record pass/fail on their record. No expected
// block => the question is ungraded and "Done" can't be claimed objectively.

const fs = require("fs");
const path = require("path");

const SLIDES_DIR = path.join(__dirname, "../../slides");

const QUESTION_MARKER = /^\s*code question:\s*/i;
// Marker must sit on its own line (preceded by a newline) so an "expected
// output:" mention inside the prompt prose doesn't get treated as the split.
const EXPECTED_MARKER = /\n[^\S\n]*expected output:[^\S\n]*\n?/i;

/**
 * Split a coding-slide speaker note into its prompt and expected-output block.
 * @param {unknown} note raw speaker-note string
 * @returns {{ isCoding: boolean, prompt: string, expected: string | null }}
 */
function parseCodingNote(note) {
  if (typeof note !== "string" || !QUESTION_MARKER.test(note)) {
    return { isCoding: false, prompt: "", expected: null };
  }
  const body = note.replace(QUESTION_MARKER, "");
  const m = body.match(EXPECTED_MARKER);
  if (!m) return { isCoding: true, prompt: body.trim(), expected: null };
  const prompt = body.slice(0, m.index).trim();
  const expected = body.slice(m.index + m[0].length);
  return { isCoding: true, prompt, expected };
}

/**
 * Normalize output for comparison: unify newlines, strip per-line trailing
 * whitespace, and drop leading/trailing blank lines. Internal blank lines and
 * spacing are preserved so multi-line output is still compared faithfully.
 */
function normalizeOutput(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+$/g, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * True when the actual program output matches the expected block after
 * whitespace normalization.
 */
function gradeOutput(actual, expected) {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

/**
 * Heuristic: does the merged stdout+stderr look like a runtime error? Mirrors
 * the sniff already used in the frontend so a crashing program never grades as
 * a pass even if its partial output happened to match.
 */
function looksLikeError(output) {
  const lower = String(output ?? "").toLowerCase();
  return (
    lower.includes("traceback") ||
    lower.includes("error") ||
    lower.includes("exception")
  );
}

function readNotes(sessionCode) {
  const p = path.join(SLIDES_DIR, sessionCode, "notes.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Expected-output string for a given slide, or null if the slide isn't a
 * coding question, has no expected block, or the notes can't be read.
 */
function getExpectedForSlide(sessionCode, slideIndex) {
  const notes = readNotes(sessionCode);
  if (!Array.isArray(notes)) return null;
  const { expected } = parseCodingNote(notes[slideIndex]);
  if (expected === null || String(expected).trim() === "") return null;
  return expected;
}

module.exports = {
  parseCodingNote,
  normalizeOutput,
  gradeOutput,
  looksLikeError,
  getExpectedForSlide,
};
