const express = require("express");
const { executeCode, ExecutorUnavailable } = require("../services/codeExecutor");
const { authorizeRun, gradeAndRecord } = require("../services/runAccess");

const router = express.Router();

router.post("/api/run", async (req, res) => {
  const { code, language, sessionCode, studentId, slideIndex } = req.body;

  const access = authorizeRun({ code, language, sessionCode, studentId, teacherToken: req.headers["x-teacher-token"] });
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const { isTeacher } = access;

  console.log("📩 /api/run", { language, sessionCode });
  try {
    const output = await executeCode({ code, language });

    // Teacher demo runs just execute and return — nothing to grade or record.
    if (isTeacher) {
      return res.json({ output, grade: { graded: false } });
    }

    const grade = gradeAndRecord({ sessionCode, studentId, slideIndex, output });
    res.json({ output, grade });
  } catch (err) {
    if (err instanceof ExecutorUnavailable) {
      // Infrastructure, not the student's program: nothing is recorded or graded.
      return res.status(503).json({ error: err.message, retryable: true });
    }
    console.warn("❗ Run error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
