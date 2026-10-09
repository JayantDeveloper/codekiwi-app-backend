// Autograding for coding-question slides. A coding slide's speaker notes hold
// the prompt and its test cases (format and matching rules in testCases.js).
// When a student runs code on a slide with tests, the backend runs their
// program once per test input and the question passes when every test does.
// No tests => the question is ungraded and "Done" can't be claimed objectively.

const fs = require("fs");
const path = require("path");
const { parseCodingNote, gradeTest, testStdin } = require("./testCases");

const SLIDES_DIR = path.join(__dirname, "../../slides");

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
 * A slide's test cases, or null if it isn't a coding question, has no tests,
 * or the notes can't be read.
 * @returns {{ tests: { input: string, output: string }[], lenient: boolean } | null}
 */
function getTestsForSlide(sessionCode, slideIndex) {
  const notes = readNotes(sessionCode);
  if (!Array.isArray(notes)) return null;
  const { tests, lenient } = parseCodingNote(notes[slideIndex]);
  return tests.length ? { tests, lenient } : null;
}

module.exports = {
  parseCodingNote,
  gradeTest,
  testStdin,
  looksLikeError,
  getTestsForSlide,
};
