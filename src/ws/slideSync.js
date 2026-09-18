const WebSocket = require("ws");
const { broadcastToSession, broadcastAll } = require("../utils/broadcast");
const {
  getCurrentSlide,
  setCurrentSlide,
  setLock,
  isLocked,
  getDemoState,
  setDemoState,
  getTeacherToken,
  getStudents,
  touchActivity,
} = require("../state/store");
const { safeEqual } = require("../utils/secrets");

const WS_PING_INTERVAL_MS = 30_000;
const MAX_SLIDE_INDEX = 5000;
const MAX_DEMO_LEN = 50_000;
const CODE_RE = /^\d{6,16}$/;

/**
 * Attach message/error/close handlers to the WebSocket server.
 * @param {WebSocket.Server} wss
 */
function attachHandlers(wss) {
  wss.on("connection", (ws) => {
    ws.sessionCode = null;
    ws.isTeacher = false;
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
      // A teacher parked on the presentation view is still "present": this
      // keeps the abandoned-session sweep from ending a class mid-video.
      if (ws.isTeacher && ws.sessionCode) touchActivity(ws.sessionCode);
    });

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        handleMessage(wss, ws, data);
      } catch (error) {
        console.error("❌ Error handling WebSocket message:", error?.message);
      }
    });

    ws.on("error", (err) => console.error("⚠️ WebSocket error:", err?.message));
  });

  // Liveness: a socket that misses a pong is dead (sleeping laptop, dropped
  // WiFi) and is terminated rather than accumulating in wss.clients forever.
  setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) {
        try { client.terminate(); } catch {}
        return;
      }
      client.isAlive = false;
      if (client.readyState === WebSocket.OPEN) {
        try { client.ping(); } catch {}
      }
    });
  }, WS_PING_INTERVAL_MS).unref();
}

function handleMessage(wss, ws, data) {
  if (!data || typeof data !== "object") return;

  if (data.type === "join") {
    const sessionCode = String(data.sessionCode || "");
    if (!CODE_RE.test(sessionCode)) return;
    ws.sessionCode = sessionCode;
    // The teacher proves identity with the session's token; everything that
    // steers the room below requires it. Students only ever receive.
    const expected = getTeacherToken(sessionCode);
    ws.isTeacher = !!expected && safeEqual(String(data.t || ""), expected);
    ws.studentId =
      data.studentId && getStudents(sessionCode).some((s) => s.id === data.studentId)
        ? data.studentId
        : null;
    if (ws.isTeacher) touchActivity(sessionCode);

    ws.send(JSON.stringify({ type: "sync", slide: getCurrentSlide(sessionCode) }));
    ws.send(JSON.stringify({ type: "lock-editors", sessionCode, locked: isLocked(sessionCode) }));
    // Catch a late-joining / refreshing student up to an in-progress demo.
    const demo = getDemoState(sessionCode);
    if (demo.active) {
      ws.send(JSON.stringify({ type: "demo-start", code: demo.code, output: demo.output }));
    }
    return;
  }

  // Everything below changes what the whole room sees: teacher only, and always
  // scoped to the session this socket joined (never a code named in the message).
  const sessionCode = ws.sessionCode;
  if (!sessionCode || !ws.isTeacher) return;
  touchActivity(sessionCode);
  const text = (v) => (typeof v === "string" ? v.slice(0, MAX_DEMO_LEN) : "");

  // ── Teacher live-demo: mirror the teacher's editor to every student ──────────
  if (data.type === "demo-start") {
    const state = setDemoState(sessionCode, { active: true, code: text(data.code), output: "" });
    broadcastToSession(wss, sessionCode, { type: "demo-start", code: state.code, output: state.output }, ws);
    return;
  }
  if (data.type === "demo-code") {
    const code = text(data.code);
    setDemoState(sessionCode, { code });
    broadcastToSession(wss, sessionCode, { type: "demo-code", code }, ws);
    return;
  }
  if (data.type === "demo-run") {
    const output = text(data.output);
    setDemoState(sessionCode, { output });
    broadcastToSession(wss, sessionCode, { type: "demo-run", output }, ws);
    return;
  }
  if (data.type === "demo-end") {
    setDemoState(sessionCode, { active: false });
    broadcastToSession(wss, sessionCode, { type: "demo-end" }, ws);
    return;
  }

  if (data.type === "change") {
    const slide = Number(data.slide);
    if (!Number.isInteger(slide) || slide < 0 || slide > MAX_SLIDE_INDEX) return;
    setCurrentSlide(sessionCode, slide);
    broadcastToSession(wss, sessionCode, { type: "sync", slide }, ws);
    return;
  }

  if (data.type === "lock-editors") {
    const locked = !!data.locked;
    setLock(sessionCode, locked);
    broadcastAll(wss, { type: "lock-editors", sessionCode, locked });
    return;
  }
  // "session-ended" is only ever broadcast by the server from POST /end.
}

module.exports = { attachHandlers };
