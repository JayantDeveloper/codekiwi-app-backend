// COMMAND TO START LOCAL TUNNEL: lt --port 4000 --subdomain tomato-slides

require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");

const { attachHandlers } = require("./src/ws/slideSync");
const { createRouter: createSessionsRouter } = require("./src/routes/sessions");
const runRouter = require("./src/routes/run");
const { scheduleCleanup, TEMP_DIR } = require("./src/utils/cleanup");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 4000;

// ── Ensure temp dir exists ────────────────────────────────────────────────────
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://192.168.1.6:3000",
      "https://codekiwi.app",
      "https://www.codekiwi.app",
    ],
    credentials: true,
  })
);
app.use(bodyParser.json({ limit: "10mb" }));
app.use("/slides", express.static(path.join(__dirname, "slides")));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(createSessionsRouter(wss));
app.use(runRouter);

app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date().toISOString() }));

// ── WebSocket ─────────────────────────────────────────────────────────────────
attachHandlers(wss);

// ── Cleanup ───────────────────────────────────────────────────────────────────
scheduleCleanup();

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});
