const WebSocket = require("ws");
const { broadcastToSession, broadcastAll } = require("../utils/broadcast");
const { getCurrentSlide, setCurrentSlide, setLock } = require("../state/store");

const WS_PING_INTERVAL_MS = 30_000;

/**
 * Attach message/error/close handlers to the WebSocket server.
 * @param {WebSocket.Server} wss
 */
function attachHandlers(wss) {
  wss.on("connection", (ws) => {
    console.log("🔌 New WebSocket connection");
    ws.sessionCode = null;

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        handleMessage(wss, ws, data);
      } catch (error) {
        console.error("❌ Error parsing WebSocket message:", error);
      }
    });

    ws.on("close", () => console.log("❌ WebSocket connection closed"));
    ws.on("error", (err) => console.error("⚠️ WebSocket error:", err));
  });

  setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.ping(); } catch {}
      }
    });
  }, WS_PING_INTERVAL_MS);
}

function handleMessage(wss, ws, data) {
  if (data.type === "join") {
    ws.sessionCode = data.sessionCode;
    ws.send(JSON.stringify({ type: "sync", slide: getCurrentSlide(ws.sessionCode) }));
    return;
  }

  if (data.type === "change") {
    const sessionCode = data.sessionCode || ws.sessionCode;
    setCurrentSlide(sessionCode, data.slide);
    console.log(`🎞 Slide changed to ${data.slide} for session ${sessionCode}`);
    broadcastToSession(wss, sessionCode, { type: "sync", slide: data.slide }, ws);
    return;
  }

  if (data.type === "lock-editors") {
    const { sessionCode, locked } = data;
    setLock(sessionCode, locked);
    console.log(`🔒 Editor lock toggle: ${!!locked} for session ${sessionCode}`);
    broadcastAll(wss, { type: "lock-editors", sessionCode, locked: !!locked });
    return;
  }

  if (data.type === "session-ended") {
    console.log(`🛑 Session ${data.sessionCode} ended by teacher`);
    broadcastAll(wss, { type: "session-ended", sessionCode: data.sessionCode });
  }
}

module.exports = { attachHandlers };
