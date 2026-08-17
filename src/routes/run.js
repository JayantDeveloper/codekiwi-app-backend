const express = require("express");
const { executeCode } = require("../services/codeExecutor");
const { getStudents, getSessionStatus, recordRun, getTeacherToken } = require("../state/store");
const { getExpectedForSlide, gradeOutput, looksLikeError } = require("../services/grader");

const router = express.Router();

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

router.post("/api/run", async (req, res) => {
  const { code, language, sessionCode, studentId, slideIndex } = req.body;

  if (!code || !language) {
    return res.status(400).json({ error: "Invalid code or language" });
  }
  if (typeof code !== "string" || code.length > MAX_CODE_LENGTH) {
    return res.status(400).json({ error: "Code too large" });
  }
  if (!sessionCode) {
    return res.status(403).json({ error: "Missing session" });
  }

  // The session must be active. The caller is either a joined student, or the
  // teacher running a live demo (authorized by the session's teacher token).
  const status = getSessionStatus(sessionCode);
  if (status && status.active === false) {
    return res.status(410).json({ error: "Session has ended" });
  }

  const providedToken = req.headers["x-teacher-token"];
  const expectedToken = getTeacherToken(sessionCode);
  const isTeacher = !!expectedToken && providedToken === expectedToken;

  if (!isTeacher) {
    if (!studentId) {
      return res.status(403).json({ error: "Missing student" });
    }
    const isMember = getStudents(sessionCode).some((s) => s.id === studentId);
    if (!isMember) {
      return res.status(403).json({ error: "Not a participant in this session" });
    }
  }

  const rateKey = isTeacher ? `${sessionCode}:teacher` : `${sessionCode}:${studentId}`;
  if (rateLimited(rateKey, Date.now())) {
    return res.status(429).json({ error: "Too many runs. Wait a moment and try again." });
  }

  console.log("📩 /api/run", { language, sessionCode });
  try {
    const output = await executeCode({ code, language });

    // Teacher demo runs just execute and return — nothing to grade or record.
    if (isTeacher) {
      return res.json({ output, grade: { graded: false } });
    }

    // Autograde against the slide's expected-output block (if any) and record
    // the run so the teacher dashboard can show real status + scores.
    const isError = looksLikeError(output);
    const idx = Number.isInteger(slideIndex) ? slideIndex : null;
    let grade = { graded: false };

    if (idx !== null) {
      const expected = getExpectedForSlide(sessionCode, idx);
      if (expected !== null) {
        const passed = !isError && gradeOutput(output, expected);
        grade = { graded: true, passed };
        recordRun(sessionCode, studentId, { slideIndex: idx, graded: true, passed, isError });
      } else {
        recordRun(sessionCode, studentId, { slideIndex: idx, graded: false, isError });
      }
    } else {
      recordRun(sessionCode, studentId, { graded: false, isError });
    }

    res.json({ output, grade });
  } catch (err) {
    console.warn("❗ Run error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
