// In-memory session state. All mutations go through the exported functions
// so there's a single place to add persistence or logging later.

/** @type {{ [sessionCode: string]: Array<{ id: string, name: string, code: string, output: string }> }} */
const studentSessions = {};

/** @type {{ [sessionCode: string]: { active: boolean, endedAt?: string } }} */
const sessionStatus = {};

/** @type {{ [sessionCode: string]: boolean }} */
const editorLocks = {};

/** @type {{ [sessionCode: string]: number }} */
const sessionSlides = {};

// ── studentSessions ──────────────────────────────────────────────────────────

function getStudents(sessionCode) {
  return studentSessions[sessionCode] || [];
}

function upsertStudent(sessionCode, { id, name, code, output }) {
  if (!studentSessions[sessionCode]) studentSessions[sessionCode] = [];
  const existing = studentSessions[sessionCode].find((s) => s.id === id);
  if (existing) {
    existing.code = code;
    existing.output = output;
  } else {
    studentSessions[sessionCode].push({ id, name, code, output });
  }
}

function getStudentColor(sessionCode) {
  const COLOR_PALETTE = [
    "#f87171", // red
    "#60a5fa", // blue
    "#fb923c", // orange
    "#a78bfa", // purple
    "#2dd4bf", // teal
    "#f472b6", // pink
    "#fbbf24", // amber
    "#818cf8", // indigo
  ];
  const count = (studentSessions[sessionCode] || []).length;
  return COLOR_PALETTE[count % COLOR_PALETTE.length];
}

function addStudent(sessionCode, student) {
  if (!studentSessions[sessionCode]) studentSessions[sessionCode] = [];
  studentSessions[sessionCode].push(student);
}

// ── sessionStatus ─────────────────────────────────────────────────────────────

function getSessionStatus(sessionCode) {
  return sessionStatus[sessionCode];
}

function setSessionStatus(sessionCode, status) {
  sessionStatus[sessionCode] = status;
}

// ── editorLocks ───────────────────────────────────────────────────────────────

function isLocked(sessionCode) {
  return !!editorLocks[sessionCode];
}

function setLock(sessionCode, locked) {
  editorLocks[sessionCode] = !!locked;
}

// ── sessionSlides ─────────────────────────────────────────────────────────────

function getCurrentSlide(sessionCode) {
  return sessionSlides[sessionCode] ?? 0;
}

function setCurrentSlide(sessionCode, slide) {
  sessionSlides[sessionCode] = slide;
}

// ── cleanup ───────────────────────────────────────────────────────────────────

function clearSession(sessionCode) {
  delete studentSessions[sessionCode];
  delete editorLocks[sessionCode];
  delete sessionSlides[sessionCode];
}

module.exports = {
  getStudents,
  upsertStudent,
  addStudent,
  getStudentColor,
  getSessionStatus,
  setSessionStatus,
  isLocked,
  setLock,
  getCurrentSlide,
  setCurrentSlide,
  clearSession,
};
