const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { broadcastAll, broadcastToStudent } = require("../utils/broadcast");
const {
  getStudents,
  getSessionCodes,
  upsertStudent,
  addStudent,
  getStudentColor,
  getSessionStatus,
  setSessionStatus,
  isLocked,
  setLock,
  setTeacherToken,
  getTeacherToken,
  touchActivity,
  getLastActivity,
  clearSession,
} = require("../state/store");

// Teacher-only guard: the caller must present the session's teacher token
// (delivered to the teacher via the add-on). Returns true if authorized, else
// responds 403 and returns false.
function requireTeacher(req, res, sessionCode) {
  const expected = getTeacherToken(sessionCode);
  const provided = req.headers["x-teacher-token"];
  if (!expected || provided !== expected) {
    res.status(403).json({ error: "Teacher authorization required" });
    return false;
  }
  return true;
}
const { processUpload } = require("../services/pdfProcessor");
const { parseCodingNote } = require("../services/grader");

const SLIDES_DIR = path.join(__dirname, "../../slides");
const SITE_END_URL = "https://www.codekiwi.tech/api/sessions/end";
const SITE_SNAPSHOT_URL = "https://www.codekiwi.tech/api/sessions/snapshot";

/**
 * @param {import('ws').Server} wss
 */
function parseNotesData(notesData) {
  if (Array.isArray(notesData)) {
    return notesData.map((n) => (typeof n === "string" ? n.trim() : ""));
  }
  if (typeof notesData !== "string") {
    notesData = String(notesData);
  }
  if (!notesData.trim()) return [];
  try {
    const parsed = JSON.parse(notesData);
    if (Array.isArray(parsed)) return parsed.map((n) => (typeof n === "string" ? n.trim() : ""));
    return [String(parsed).trim()];
  } catch {
    return [notesData.trim()];
  }
}

function readNotesFile(sessionCode) {
  const notesPath = path.join(SLIDES_DIR, sessionCode, "notes.json");
  if (!fs.existsSync(notesPath)) return null;
  return JSON.parse(fs.readFileSync(notesPath, "utf-8"));
}

// Build the gradebook snapshot for the site DB from current in-memory state.
// Returns plain data (a value copy), so it's safe to clear session state after.
// For each student, one answer per coding-question slide: their code, output,
// and pass/fail — even for questions they never attempted (passed: null).
function buildSessionSnapshot(sessionCode) {
  const notes = readNotesFile(sessionCode);
  const codingSlides = Array.isArray(notes)
    ? notes.reduce((acc, note, i) => {
        if (parseCodingNote(note).isCoding) acc.push(i);
        return acc;
      }, [])
    : [];
  const total = codingSlides.length;

  const students = getStudents(sessionCode).map((s) => {
    const grades = s.grades || {};
    const codeBySlide = s.codeBySlide || {};
    const outputBySlide = s.outputBySlide || {};
    const answers = codingSlides.map((idx) => {
      const g = grades[idx];
      return {
        slideIndex: idx,
        code: codeBySlide[idx] || "",
        output: outputBySlide[idx] || "",
        passed: g ? !!g.passed : null,
        ranAt: g && g.ranAt ? new Date(g.ranAt).toISOString() : null,
      };
    });
    const score = codingSlides.reduce(
      (n, idx) => n + (grades[idx] && grades[idx].passed ? 1 : 0),
      0
    );
    return { name: s.name || "Unnamed", score, total, answers };
  });

  return { sessionCode, students };
}

// Persist a session's gradebook snapshot to the site (best-effort). Used both
// at session end and by the periodic autosave. No-op if there's nothing to save.
function postSnapshot(sessionCode) {
  const snapshot = buildSessionSnapshot(sessionCode);
  if (!snapshot.students.length) return;
  const secret = process.env.APPSCRIPT_SECRET;
  return fetch(SITE_SNAPSHOT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-codekiwi-secret": secret } : {}),
    },
    body: JSON.stringify(snapshot),
  }).catch((err) => console.warn("Site snapshot failed:", err?.message));
}

// Finalize a session: persist the gradebook snapshot, mark it ended (in memory,
// on disk, and in the site DB), tell students, then clear in-memory state. Used
// both by the teacher's explicit End and by the abandoned-session sweep below.
// Returns false if the session's slides no longer exist. Safe to call twice.
function finalizeSession(sessionCode, wss) {
  const sessionDir = path.join(SLIDES_DIR, sessionCode);
  if (!fs.existsSync(sessionDir)) return false;

  const endedAt = new Date().toISOString();
  setSessionStatus(sessionCode, { active: false, endedAt });

  const metaPath = path.join(sessionDir, "meta.json");
  let meta = {};
  try {
    if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {}
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, ended: true, endedAt }, null, 2));

  broadcastAll(wss, { type: "session-ended", sessionCode });

  const studentCount = getStudents(sessionCode).length;
  const secret = process.env.APPSCRIPT_SECRET;

  // Persist the final gradebook snapshot BEFORE clearing in-memory state.
  postSnapshot(sessionCode);
  clearSession(sessionCode);

  // Best-effort: update endedAt + studentCount in the site's DB.
  fetch(SITE_END_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-codekiwi-secret": secret } : {}),
    },
    body: JSON.stringify({ sessionCode, studentCount }),
  }).catch((err) => console.warn("Site session-end notify failed:", err?.message));

  return true;
}

// Crash-safety + abandoned-session cleanup. Session state lives in memory, so a
// Render restart mid-lesson would lose everything — snapshot every live session
// each tick so the most a crash costs is one interval. AND, when a teacher just
// closes the tab without clicking End, no one ever sets endedAt: the session
// would show "Active" forever and its gradebook would stay unreachable. So if a
// session has had no student heartbeat or teacher poll for STALE_MS, finalize it
// automatically. A session that anyone still has open keeps heartbeating (every
// 3s), so only a truly abandoned one is ended.
const AUTOSAVE_MS = 60_000;
const STALE_MS = 30 * 60_000; // 30 min of total silence → abandoned
let autosaveStarted = false;
function startAutosave(wss) {
  if (autosaveStarted) return;
  autosaveStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const code of getSessionCodes()) {
      const status = getSessionStatus(code);
      if (status && status.active === false) continue; // ended; already saved
      const last = getLastActivity(code);
      // Unknown last-activity (e.g. a session live across this deploy): treat now
      // as its baseline instead of finalizing it out from under a live class.
      if (!last) {
        touchActivity(code);
        postSnapshot(code);
        continue;
      }
      if (now - last > STALE_MS) {
        console.log(`⏱️  Auto-finalizing abandoned session ${code} (silent ${Math.round((now - last) / 60000)}m)`);
        finalizeSession(code, wss);
      } else {
        postSnapshot(code);
      }
    }
  }, AUTOSAVE_MS).unref();
}

function createRouter(wss) {
  const router = express.Router();
  startAutosave(wss);

  // ── Upload / create session ───────────────────────────────────────────────
  router.post("/api/sessions/upload", async (req, res) => {
    const secret = process.env.APPSCRIPT_SECRET;
    if (secret && req.headers["x-codekiwi-secret"] !== secret) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { notes, slidesUrl, thumbnailUrls, language } = req.body;
    if (!Array.isArray(thumbnailUrls) || !thumbnailUrls.length || !Array.isArray(notes) || !slidesUrl) {
      return res.status(400).json({ success: false, message: "Missing fields in request body" });
    }

    try {
      const { sessionCode } = await processUpload({ thumbnailUrls, notes, slidesUrl, language });
      setSessionStatus(sessionCode, { active: true });
      setLock(sessionCode, false);
      const teacherToken = crypto.randomBytes(24).toString("hex");
      setTeacherToken(sessionCode, teacherToken);
      touchActivity(sessionCode); // baseline so a brand-new session isn't seen as stale
      res.status(201).json({ success: true, sessionCode, teacherToken });
    } catch (err) {
      console.error("❌ Upload error:", err?.message || err);
      console.error("❌ Stack:", err?.stack);
      res.status(500).json({ success: false, message: "Failed to process upload", detail: err?.message });
    }
  });

  // ── Student join ──────────────────────────────────────────────────────────
  router.post("/api/sessions/:sessionCode/join", (req, res) => {
    const { sessionCode } = req.params;
    const { name } = req.body;

    const status = getSessionStatus(sessionCode);
    if (status && status.active === false) {
      return res.status(410).json({ error: "Session has ended" });
    }
    if (!name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    const studentId = uuidv4();
    const color = getStudentColor(sessionCode);
    addStudent(sessionCode, { id: studentId, name: name.trim(), code: "", output: "", color });
    res.json({ studentId, color });
  });

  // ── Student list ──────────────────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/students", (req, res) => {
    const { sessionCode } = req.params;
    if (!requireTeacher(req, res, sessionCode)) return;
    touchActivity(sessionCode); // teacher is present
    res.json({ students: getStudents(sessionCode) });
  });

  // ── Student code update (heartbeat) ──────────────────────────────────────
  router.post("/api/sessions/:sessionCode/code", (req, res) => {
    const { sessionCode } = req.params;
    const { studentId, name, code, output, handRaised, slideIndex } = req.body;
    if (!studentId || !name) {
      return res.status(400).json({ error: "Missing studentId or name" });
    }
    upsertStudent(sessionCode, { id: studentId, name, code, output, handRaised, slideIndex });
    touchActivity(sessionCode); // a student is active
    res.json({ success: true });
  });

  // ── Teacher inspect student ───────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/students/:studentId", (req, res) => {
    const { sessionCode, studentId } = req.params;
    if (!requireTeacher(req, res, sessionCode)) return;
    const student = getStudents(sessionCode).find((s) => s.id === studentId);
    if (!student) return res.status(404).json({ error: "Student not found" });
    res.json({
      name: student.name || "Unknown",
      code: student.code || "",
      output: student.output || "",
      handRaised: !!student.handRaised,
      lastRunPassed: student.lastRunPassed ?? null,
      grades: student.grades || {},
    });
  });

  // ── Teacher code override → broadcasts to student ────────────────────────
  router.post("/api/sessions/:sessionCode/students/:studentId/override", (req, res) => {
    const { sessionCode, studentId } = req.params;
    if (!requireTeacher(req, res, sessionCode)) return;
    const { code } = req.body;
    const students = getStudents(sessionCode);
    const student = students.find((s) => s.id === studentId);
    if (!student) return res.status(404).json({ error: "Student not found" });
    upsertStudent(sessionCode, { ...student, code });
    broadcastToStudent(wss, sessionCode, studentId, { type: "code-override", code });
    res.json({ success: true });
  });

  // ── Teacher editing indicator → broadcasts to student ────────────────────
  router.post("/api/sessions/:sessionCode/students/:studentId/editing", (req, res) => {
    const { sessionCode, studentId } = req.params;
    if (!requireTeacher(req, res, sessionCode)) return;
    const editing = !!(req.body?.editing);
    broadcastToStudent(wss, sessionCode, studentId, { type: "teacher-editing", editing });
    res.json({ success: true });
  });

  // ── Notes ─────────────────────────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/notes", (req, res) => {
    const notes = readNotesFile(req.params.sessionCode);
    if (!notes) return res.status(404).json({ error: "Notes not found" });
    res.json({ notes });
  });

  // ── Coding slides ─────────────────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/coding-slides", (req, res) => {
    const notes = readNotesFile(req.params.sessionCode);
    if (!notes) return res.status(404).json({ error: "Notes not found" });
    const codingSlides = notes.reduce((acc, note, index) => {
      if (typeof note === "string" && note.startsWith("Code Question:")) acc.push(index);
      return acc;
    }, []);
    res.json({ codingSlides });
  });

  // ── Session existence check ───────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/exists", (req, res) => {
    const { sessionCode } = req.params;
    const sessionPath = path.join(SLIDES_DIR, sessionCode);
    const exists = fs.existsSync(sessionPath);

    let active = getSessionStatus(sessionCode)?.active;
    if (active === undefined) {
      const metaPath = path.join(sessionPath, "meta.json");
      if (exists && fs.existsSync(metaPath)) {
        try {
          active = !JSON.parse(fs.readFileSync(metaPath, "utf-8")).ended;
        } catch {
          active = true;
        }
      } else {
        active = exists;
      }
    }

    res.json({ exists, active });
  });

  // ── Editor lock GET/POST ──────────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/lock", (req, res) => {
    res.json({ locked: isLocked(req.params.sessionCode) });
  });

  router.post("/api/sessions/:sessionCode/lock", (req, res) => {
    const { sessionCode } = req.params;
    if (!requireTeacher(req, res, sessionCode)) return;
    const locked = !!(req.body?.locked);
    setLock(sessionCode, locked);
    broadcastAll(wss, { type: "lock-editors", sessionCode, locked });
    res.json({ success: true, locked });
  });

  // ── End session ───────────────────────────────────────────────────────────
  router.post("/api/sessions/:sessionCode/end", (req, res) => {
    const { sessionCode } = req.params;
    if (!requireTeacher(req, res, sessionCode)) return;
    if (!finalizeSession(sessionCode, wss)) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ success: true });
  });

  // ── Live teacher token (for Rejoin) ───────────────────────────────────────
  // The site calls this (secret-gated, after verifying the logged-in teacher
  // owns the session) to get the live teacher token so it can hand the teacher
  // back into their running session. 404 once the session is no longer live.
  router.get("/api/sessions/:sessionCode/teacher-token", (req, res) => {
    const secret = process.env.APPSCRIPT_SECRET;
    if (secret && req.headers["x-codekiwi-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { sessionCode } = req.params;
    const status = getSessionStatus(sessionCode);
    const token = getTeacherToken(sessionCode);
    if (!token || (status && status.active === false)) {
      return res.status(404).json({ error: "Session is not live" });
    }
    res.json({ teacherToken: token });
  });

  return router;
}

module.exports = { createRouter };
