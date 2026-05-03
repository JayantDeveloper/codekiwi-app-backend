const express = require("express");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { broadcastAll } = require("../utils/broadcast");
const {
  getStudents,
  upsertStudent,
  addStudent,
  getStudentColor,
  getSessionStatus,
  setSessionStatus,
  isLocked,
  setLock,
  clearSession,
} = require("../state/store");
const { processUpload } = require("../services/pdfProcessor");

const SLIDES_DIR = path.join(__dirname, "../../slides");

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

function createRouter(wss) {
  const router = express.Router();

  // ── Upload / create session ───────────────────────────────────────────────
  router.post("/api/sessions/upload", async (req, res) => {
    const secret = process.env.APPSCRIPT_SECRET;
    if (secret && req.headers["x-codekiwi-secret"] !== secret) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { notes, slidesUrl, fileBase64, language } = req.body;
    if (!fileBase64 || !Array.isArray(notes) || !slidesUrl) {
      return res.status(400).json({ success: false, message: "Missing fields in request body" });
    }

    try {
      const { sessionCode } = await processUpload({ fileBase64, notes, slidesUrl, language });
      setSessionStatus(sessionCode, { active: true });
      setLock(sessionCode, false);
      res.status(201).json({ success: true, sessionCode });
    } catch (err) {
      console.error("❌ Upload error:", err);
      res.status(500).json({ success: false, message: "Failed to process upload" });
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
    res.json({ students: getStudents(req.params.sessionCode) });
  });

  // ── Student code update (heartbeat) ──────────────────────────────────────
  router.post("/api/sessions/:sessionCode/code", (req, res) => {
    const { sessionCode } = req.params;
    const { studentId, name, code, output } = req.body;
    if (!studentId || !name) {
      return res.status(400).json({ error: "Missing studentId or name" });
    }
    upsertStudent(sessionCode, { id: studentId, name, code, output });
    res.json({ success: true });
  });

  // ── Teacher inspect student ───────────────────────────────────────────────
  router.get("/api/sessions/:sessionCode/students/:studentId", (req, res) => {
    const { sessionCode, studentId } = req.params;
    const student = getStudents(sessionCode).find((s) => s.id === studentId);
    if (!student) return res.status(404).json({ error: "Student not found" });
    res.json({ name: student.name || "Unknown", code: student.code || "", output: student.output || "" });
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
    const locked = !!(req.body?.locked);
    setLock(sessionCode, locked);
    broadcastAll(wss, { type: "lock-editors", sessionCode, locked });
    res.json({ success: true, locked });
  });

  // ── End session ───────────────────────────────────────────────────────────
  router.post("/api/sessions/:sessionCode/end", (req, res) => {
    const { sessionCode } = req.params;
    const sessionDir = path.join(SLIDES_DIR, sessionCode);
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: "Session not found" });
    }

    const endedAt = new Date().toISOString();
    setSessionStatus(sessionCode, { active: false, endedAt });

    const metaPath = path.join(sessionDir, "meta.json");
    let meta = {};
    try {
      if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {}
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, ended: true, endedAt }, null, 2));

    broadcastAll(wss, { type: "session-ended", sessionCode });
    clearSession(sessionCode);
    res.json({ success: true });
  });

  return router;
}

module.exports = { createRouter };
