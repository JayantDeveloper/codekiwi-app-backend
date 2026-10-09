// Who may run code in a session, shared by POST /api/run and the interactive
// /run WebSocket so the two paths can never drift apart.

const { getStudents, getSessionStatus, getTeacherToken, isLocked, recordRun } = require("../state/store");
const { getTestsForSlide, gradeTest, testStdin, looksLikeError } = require("./grader");
const { executeTests } = require("./codeExecutor");
const { safeEqual } = require("../utils/secrets");

const MAX_CODE_LENGTH = 50_000;

// Per-student sliding-window rate limit. Keyed by session+student, NOT by IP:
// a classroom of students shares one school NAT IP, so per-IP limiting would
// throttle the whole room.
const RATE_WINDOW_MS = 20_000;
const RATE_MAX = 15;
const runHits = new Map(); // `${sessionCode}:${studentId}` -> number[] timestamps

function rateLimited(key, now) {
  const arr = (runHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  runHits.set(key, arr);
  return arr.length > RATE_MAX;
}

// Bound memory: drop stale rate-limit buckets periodically.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of runHits) {
    const kept = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (kept.length) runHits.set(key, kept);
    else runHits.delete(key);
  }
}, 60_000).unref();

/**
 * Validate a run request. Returns { ok: true, isTeacher } or
 * { ok: false, status, error } with the HTTP status the REST route would use.
 */
function authorizeRun({ code, language, sessionCode, studentId, teacherToken }) {
  if (!code || !language) return { ok: false, status: 400, error: "Invalid code or language" };
  if (typeof code !== "string" || code.length > MAX_CODE_LENGTH) return { ok: false, status: 400, error: "Code too large" };
  if (!sessionCode) return { ok: false, status: 403, error: "Missing session" };

  // The session must be active. The caller is either a joined student, or the
  // teacher running a live demo (authorized by the session's teacher token).
  const status = getSessionStatus(sessionCode);
  if (status && status.active === false) return { ok: false, status: 410, error: "Session has ended" };

  const expectedToken = getTeacherToken(sessionCode);
  const isTeacher = !!expectedToken && safeEqual(teacherToken, expectedToken);

  if (!isTeacher) {
    if (!studentId) return { ok: false, status: 403, error: "Missing student" };
    const isMember = getStudents(sessionCode).some((s) => s.id === studentId);
    if (!isMember) return { ok: false, status: 403, error: "Not a participant in this session" };
    // "Lock Editors" is enforced here, not just in the browser's read-only flag.
    if (isLocked(sessionCode)) return { ok: false, status: 423, error: "Editors are locked by your teacher." };
  }

  const rateKey = isTeacher ? `${sessionCode}:teacher` : `${sessionCode}:${studentId}`;
  if (rateLimited(rateKey, Date.now())) return { ok: false, status: 429, error: "Too many runs. Wait a moment and try again." };

  return { ok: true, isTeacher };
}

const MAX_SHOWN_OUTPUT = 2000; // per test, sent back to the student

/**
 * Grade a student's run and record it so the teacher dashboard shows real
 * status + scores. On a slide with test cases, the student's program is run
 * once per test input (on the executor) and the question passes when every
 * test does. Without tests the run is recorded ungraded.
 *
 * `crashed` is the interactive run's exit status when known: a non-zero exit
 * means it failed, whatever it printed. When unknown, fall back to sniffing
 * the output for "error"/"traceback".
 *
 * @returns {Promise<{ graded: boolean, passed?: boolean, isError: boolean,
 *   passedCount?: number, total?: number, compileError?: string,
 *   tests?: { input: string, expected: string, got: string, passed: boolean }[] }>}
 */
async function gradeAndRecord({ sessionCode, studentId, slideIndex, code, language, output, crashed, testRun }) {
  const idx = Number.isInteger(slideIndex) ? slideIndex : null;
  const runFailed = typeof crashed === "boolean" ? crashed : looksLikeError(output);
  const spec = idx === null ? null : getTestsForSlide(sessionCode, idx);
  if (!spec) {
    recordRun(sessionCode, studentId, { ...(idx === null ? {} : { slideIndex: idx }), graded: false, isError: runFailed });
    return { graded: false, isError: runFailed };
  }

  // `testRun`: results the executor already produced right after an
  // interactive run (same binary). Otherwise run the tests now.
  let result = testRun && !testRun.error ? testRun : null;
  try {
    if (!result) result = await executeTests({ code, language, inputs: spec.tests.map((t) => testStdin(t.input)) });
  } catch (err) {
    // Couldn't run the tests (runner busy or down): record the run ungraded
    // rather than failing a student for an infrastructure problem.
    console.warn("Test run failed:", err.message);
    recordRun(sessionCode, studentId, { slideIndex: idx, graded: false, isError: runFailed });
    return { graded: false, isError: runFailed, unavailable: true };
  }

  if (result.compileOutput) {
    recordRun(sessionCode, studentId, { slideIndex: idx, graded: true, passed: false, isError: true });
    return { graded: true, passed: false, isError: true, passedCount: 0, total: spec.tests.length, compileError: result.compileOutput.slice(0, MAX_SHOWN_OUTPUT) };
  }

  const tests = spec.tests.map((t, i) => {
    const r = (result.results || [])[i] || { output: "", notice: "Not run", exitCode: null };
    const got = r.notice ? `${r.output}${r.output && !r.output.endsWith("\n") ? "\n" : ""}${r.notice}` : r.output;
    // A test passes only if the program also exited cleanly: printing the right
    // answer and then crashing or returning non-zero is still a failure.
    const passed = !r.notice && r.exitCode === 0 && gradeTest(r.output, t.output, spec.lenient);
    return { input: t.input, expected: t.output, got: got.slice(0, MAX_SHOWN_OUTPUT), passed, crashed: !!r.notice || (r.exitCode !== 0 && r.exitCode != null) };
  });
  const passedCount = tests.filter((t) => t.passed).length;
  const passed = passedCount === tests.length;
  const isError = !passed && (runFailed || tests.some((t) => !t.passed && t.crashed));
  recordRun(sessionCode, studentId, { slideIndex: idx, graded: true, passed, isError });
  return { graded: true, passed, isError, passedCount, total: tests.length, tests: tests.map(({ crashed: _c, ...t }) => t) };
}

module.exports = { authorizeRun, gradeAndRecord };
