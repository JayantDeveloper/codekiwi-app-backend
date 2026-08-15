// In-memory session state. All mutations go through the exported functions
// so there's a single place to add persistence or logging later.

/**
 * @type {{ [sessionCode: string]: Array<{
 *   id: string, name: string, code: string, output: string, color?: string,
 *   handRaised?: boolean, lastRunAt?: number, lastRunError?: boolean,
 *   lastRunPassed?: boolean | null, runFailStreak?: number,
 *   grades?: { [slideIndex: number]: { passed: boolean, ranAt: number } },
 *   codeBySlide?: { [slideIndex: number]: string },
 *   outputBySlide?: { [slideIndex: number]: string },
 * }> }}
 */
const studentSessions = {};

/** @type {{ [sessionCode: string]: { active: boolean, endedAt?: string } }} */
const sessionStatus = {};

/** @type {{ [sessionCode: string]: boolean }} */
const editorLocks = {};

/** @type {{ [sessionCode: string]: number }} */
const sessionSlides = {};

/** @type {{ [sessionCode: string]: string }} */
const teacherTokens = {};

// ── studentSessions ──────────────────────────────────────────────────────────

function getStudents(sessionCode) {
  return studentSessions[sessionCode] || [];
}

// Merge-update a student. Only the fields actually present in `fields` are
// written, so the 3s heartbeat (code/output/handRaised) never clobbers grade
// or status fields set by recordRun — and vice versa.
//
// When the heartbeat reports which slide the student is on (`slideIndex`), we
// also keep a per-slide snapshot of their code + output. That's what the
// end-of-session gradebook is built from: the flat `code`/`output` is only the
// last-active buffer, but `codeBySlide`/`outputBySlide` retain each question's
// work even after the student moves on.
function upsertStudent(sessionCode, fields) {
  const { id } = fields;
  if (!studentSessions[sessionCode]) studentSessions[sessionCode] = [];
  let existing = studentSessions[sessionCode].find((s) => s.id === id);
  if (!existing) {
    existing = {
      id,
      name: fields.name || "",
      code: fields.code || "",
      output: fields.output || "",
      handRaised: !!fields.handRaised,
    };
    studentSessions[sessionCode].push(existing);
  } else {
    if (fields.name !== undefined) existing.name = fields.name;
    if (fields.code !== undefined) existing.code = fields.code;
    if (fields.output !== undefined) existing.output = fields.output;
    if (fields.handRaised !== undefined) existing.handRaised = !!fields.handRaised;
  }

  if (Number.isInteger(fields.slideIndex)) {
    if (!existing.codeBySlide) existing.codeBySlide = {};
    if (!existing.outputBySlide) existing.outputBySlide = {};
    if (fields.code !== undefined) existing.codeBySlide[fields.slideIndex] = fields.code;
    if (fields.output !== undefined) existing.outputBySlide[fields.slideIndex] = fields.output;
  }
}

// Record the outcome of a student's code run: timestamp, error flag, and (when
// the slide has an expected-output block) autograde pass/fail per slide index.
// `runFailStreak` tracks consecutive unsuccessful runs so the dashboard can
// auto-flag a student who's stuck even if they haven't raised their hand.
function recordRun(sessionCode, studentId, { slideIndex, graded, passed, isError }) {
  const students = studentSessions[sessionCode];
  if (!students) return;
  const s = students.find((st) => st.id === studentId);
  if (!s) return;

  s.lastRunAt = Date.now();
  s.lastRunError = !!isError;

  if (graded) {
    s.lastRunPassed = !!passed;
    if (!s.grades) s.grades = {};
    if (Number.isInteger(slideIndex)) {
      s.grades[slideIndex] = { passed: !!passed, ranAt: s.lastRunAt };
    }
    s.runFailStreak = passed ? 0 : (s.runFailStreak || 0) + 1;
  } else {
    // Ungraded run: correctness is unknown, so never claim "Done". A crash
    // still counts toward the stuck streak; a clean run resets it.
    s.lastRunPassed = null;
    s.runFailStreak = isError ? (s.runFailStreak || 0) + 1 : 0;
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

// ── teacherTokens ─────────────────────────────────────────────────────────────
// Secret held only by the teacher (delivered via the add-on into the teacher-view
// URL). Required for teacher-only actions so students/outsiders who know the
// 6-digit session code cannot end the class, lock editors, or read/override code.

function setTeacherToken(sessionCode, token) {
  teacherTokens[sessionCode] = token;
}

function getTeacherToken(sessionCode) {
  return teacherTokens[sessionCode];
}

// ── cleanup ───────────────────────────────────────────────────────────────────

function clearSession(sessionCode) {
  delete studentSessions[sessionCode];
  delete editorLocks[sessionCode];
  delete sessionSlides[sessionCode];
  delete teacherTokens[sessionCode];
}

module.exports = {
  getStudents,
  upsertStudent,
  recordRun,
  addStudent,
  getStudentColor,
  getSessionStatus,
  setSessionStatus,
  isLocked,
  setLock,
  getCurrentSlide,
  setCurrentSlide,
  setTeacherToken,
  getTeacherToken,
  clearSession,
};
