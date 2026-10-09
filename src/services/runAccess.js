// Who may run code in a session, shared by POST /api/run and the interactive
// /run WebSocket so the two paths can never drift apart.

const { getStudents, getSessionStatus, getTeacherToken, isLocked, recordRun } = require("../state/store");
const { getExpectedForSlide, gradeOutput, looksLikeError } = require("./grader");
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

/**
 * Autograde a student's run against the slide's expected-output block (if any)
 * and record it so the teacher dashboard shows real status + scores.
 * An exact match wins outright: legitimate output like "Error: age must be
 * positive" must not be vetoed by the crash heuristic.
 * `crashed` is the program's exit status when known (interactive runs): a
 * non-zero exit means it failed, whatever it printed. When unknown, fall back
 * to sniffing the output for "error"/"traceback", which misses silent crashes
 * and flags programs that merely print the word "error". `isError` lets the student's terminal say "your program hit an error"
 * instead of "Done" or "Not quite".
 * @returns {{ graded: boolean, passed?: boolean, isError: boolean }}
 */
function gradeAndRecord({ sessionCode, studentId, slideIndex, output, crashed }) {
  const idx = Number.isInteger(slideIndex) ? slideIndex : null;
  const failed = () => (typeof crashed === "boolean" ? crashed : looksLikeError(output));
  if (idx === null) {
    const isError = failed();
    recordRun(sessionCode, studentId, { graded: false, isError });
    return { graded: false, isError };
  }
  const expected = getExpectedForSlide(sessionCode, idx);
  if (expected === null) {
    const isError = failed();
    recordRun(sessionCode, studentId, { slideIndex: idx, graded: false, isError });
    return { graded: false, isError };
  }
  const passed = gradeOutput(output, expected);
  const isError = !passed && failed();
  recordRun(sessionCode, studentId, { slideIndex: idx, graded: true, passed, isError });
  return { graded: true, passed, isError };
}

module.exports = { authorizeRun, gradeAndRecord };
