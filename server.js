// COMMAND TO START LOCAL TUNNEL: lt --port 4000 --subdomain tomato-slides

require("dotenv").config();
const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");

const app = express();
let server;

if (process.env.NODE_ENV === "DEV") {
  server = http.createServer(app);
} else {
  const options = {
    key: fs.readFileSync("/etc/letsencrypt/live/api.codekiwi.app/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/api.codekiwi.app/fullchain.pem"),
    rejectUnauthorized: false,
  };

  server = https.createServer(options, app);
}

const wss = new WebSocket.Server({ server });

const PORT = process.env.NODE_ENV === "DEV" ? 4000 : 443;

// In-memory stores
const studentSessions = {}; // { [sessionCode]: Array<{ id, name, code, output }> }
const sessionStatus = {}; // { [sessionCode]: { active: boolean, endedAt?: string } }
const editorLocks = {}; // { [sessionCode]: boolean }  <-- NEW: single source of truth

// ------------------------ UTILITIES ------------------------

function parseNotesData(notesData) {
  if (Array.isArray(notesData)) {
    return notesData.map((note) =>
      typeof note === "string" ? note.trim() : ""
    );
  }
  if (typeof notesData !== "string") {
    console.warn(
      "Notes data is not string or array, converting:",
      typeof notesData
    );
    notesData = String(notesData);
  }
  if (!notesData || !notesData.trim()) return [];
  try {
    const parsed = JSON.parse(notesData);
    if (Array.isArray(parsed)) {
      return parsed.map((note) =>
        typeof note === "string" ? note.trim() : ""
      );
    }
    console.warn("Parsed notes data is not an array, wrapping:", parsed);
    return [String(parsed).trim()];
  } catch (jsonError) {
    console.warn(
      "Failed to parse notes as JSON, treating as single note:",
      jsonError.message
    );
    return [notesData.trim()];
  }
}

// ------------------------ MIDDLEWARE ------------------------

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://192.168.1.6:3000",
      "https://codekiwi.app",
      "https://www.codekiwi.app",
    ],
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: "10mb" }));
app.use("/slides", express.static(path.join(__dirname, "slides")));
const upload = multer({ dest: "uploads/" });

// ------------------------ SLIDE SYNC ------------------------

const sessionSlides = {}; // { [sessionCode]: number } — per-session current slide

wss.on("connection", (ws) => {
  console.log("🔌 New WebSocket connection");
  // Client must send a { type: "join", sessionCode } message to subscribe to a session
  ws.sessionCode = null;

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "join") {
        ws.sessionCode = data.sessionCode;
        const slide = sessionSlides[ws.sessionCode] ?? 0;
        ws.send(JSON.stringify({ type: "sync", slide }));
        return;
      }

      if (data.type === "change") {
        const sessionCode = data.sessionCode || ws.sessionCode;
        sessionSlides[sessionCode] = data.slide;
        console.log(`🎞 Slide changed to ${data.slide} for session ${sessionCode}`);
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.sessionCode === sessionCode) {
            client.send(JSON.stringify({ type: "sync", slide: data.slide }));
          }
        });
      }

      if (data.type === "lock-editors") {
        const { sessionCode, locked } = data;
        editorLocks[sessionCode] = !!locked; // <-- NEW: persist
        console.log(
          `🔒 Editor lock toggle: ${!!locked} for session ${sessionCode}`
        );

        // Broadcast to everyone (teacher + students + dashboards)
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "lock-editors",
                sessionCode,
                locked: !!locked,
              })
            );
          }
        });
      }

      if (data.type === "session-ended") {
        console.log(`🛑 Session ${data.sessionCode} ended by teacher`);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "session-ended",
                sessionCode: data.sessionCode,
              })
            );
          }
        });
      }
    } catch (error) {
      console.error("❌ Error parsing WebSocket message:", error);
    }
  });

  ws.on("close", () => console.log("❌ WebSocket connection closed"));
  ws.on("error", (err) => console.error("⚠️ WebSocket error:", err));
});

// ------------------------ PDF UPLOAD ------------------------

app.post("/api/sessions/upload", async (req, res) => {
  const secret = process.env.APPSCRIPT_SECRET;
  if (secret && req.headers["x-codekiwi-secret"] !== secret) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const { pdf } = await import("pdf-to-img");

  const { presentationId, title, notes, slidesUrl, fileBase64 } = req.body;

  if (!fileBase64 || !Array.isArray(notes) || !slidesUrl) {
    return res
      .status(400)
      .json({ success: false, message: "Missing fields in request body" });
  }

  const sessionId = Date.now().toString();
  sessionStatus[sessionId] = { active: true };
  editorLocks[sessionId] = false; // <-- NEW: default unlocked on create
  const outputDir = path.join(__dirname, "slides", sessionId);

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    const pdfBuffer = Buffer.from(fileBase64, "base64");
    const pdfPath = path.join(outputDir, `${sessionId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    const document = await pdf(pdfPath, { scale: 3 });

    let counter = 1;
    for await (const image of document) {
      const filename = `slide-${counter}.png`;
      await fs.promises.writeFile(path.join(outputDir, filename), image);
      counter++;
    }

    fs.writeFileSync(
      path.join(outputDir, "notes.json"),
      JSON.stringify(notes, null, 2)
    );
    fs.writeFileSync(
      path.join(outputDir, "index.json"),
      JSON.stringify(
        {
          slides: fs
            .readdirSync(outputDir)
            .filter((f) => f.endsWith(".png"))
            .sort()
            .map((f) => `/slides/${sessionId}/${f}`),
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(outputDir, "meta.json"),
      JSON.stringify({ slidesUrl }, null, 2)
    );

    res.status(201).json({ success: true, sessionCode: sessionId });
    console.log(`✅ Session ${sessionId} created with ${counter - 1} slides`);
  } catch (err) {
    console.error("❌ Upload error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to process upload" });
  }
});

// ------------------------ CODE EXECUTION ------------------------

const LANG_CONFIG = {
  python: {
    extension: "py",
    image: "python:3.10",
    cmd: (filename) => `python -u ${filename}`,
  },
  javascript: {
    extension: "js",
    image: "node:20",
    cmd: (filename) => `node ${filename}`,
  },
  java: {
    extension: "java",
    image: "openjdk:17",
    cmd: (filename) => `javac ${filename} && java ${path.parse(filename).name}`,
  },
};

app.post("/api/run", async (req, res) => {
  const { code, language } = req.body;
  console.log("📩 Incoming /api/run request");

  if (!code || !language || !LANG_CONFIG[language]) {
    console.warn("❗ Invalid request - Missing code or language");
    return res.status(400).json({ error: "Invalid code or language" });
  }

  console.log(
    "🧾 Code received:\n-----BEGIN CODE-----\n%s\n------END CODE------\n🗣 Language: %s",
    code,
    language
  );

  const { extension, image, cmd } = LANG_CONFIG[language];
  const filename = `Main.${extension}`;
  const tempPath = path.join(__dirname, "temp");

  if (!fs.existsSync(tempPath)) {
    console.log("📂 Temp directory not found. Creating:", tempPath);
    fs.mkdirSync(tempPath);
  }

  const filePath = path.join(tempPath, filename);
  console.log("📝 Writing code to:", filePath);
  fs.writeFileSync(filePath, code, "utf8");

  const child = spawn("sudo", [
    "docker",
    "run",
    "--rm",
    "-v",
    `${tempPath}:/usr/src/app`,
    "-w",
    "/usr/src/app",
    "--memory=100m",
    "--cpus=0.5",
    image,
    "sh",
    "-c",
    cmd(filename),
  ]);

  let stdout = "";
  let stderr = "";
  let responded = false;

  const timer = setTimeout(() => {
    if (responded) return;
    responded = true;
    child.kill("SIGKILL");
    console.log("⛔ Execution killed due to timeout");
    return res.json({
      output: "⏰ Execution timed out (possible infinite loop)",
    });
  }, 10000);

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("error", (err) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    console.error("❌ Spawn error:", err);
    res.json({ output: "Failed to run code: " + err.message });
  });

  child.on("close", (code) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    if (code !== 0) {
      console.log("❌ Process exited with code", code);
      return res.json({ output: stderr || "Unknown error" });
    }
    console.log("✅ Execution success:\n", stdout);
    res.json({ output: stdout });
  });
});

// ------------------------ DASHBOARD UPDATES ------------------------

app.get("/api/sessions/:sessionCode/students", (req, res) => {
  const { sessionCode } = req.params;
  const students = studentSessions[sessionCode] || [];
  res.json({ students });
});

app.post("/api/sessions/:sessionCode/code", (req, res) => {
  const { sessionCode } = req.params;
  const { studentId, name, code, output } = req.body;

  if (!studentId || !name) {
    return res.status(400).json({ error: "Missing studentId or name" });
  }

  if (!studentSessions[sessionCode]) {
    studentSessions[sessionCode] = [];
  }

  const existing = (studentSessions[sessionCode] || []).find(
    (s) => s.id === studentId
  );
  if (existing) {
    existing.code = code;
    existing.output = output;
  } else {
    studentSessions[sessionCode].push({ id: studentId, name, code, output });
  }

  res.json({ success: true });
});

// ------------------------ TEACHER INSPECT CODE VIEW ------------------------

app.get("/api/sessions/:sessionCode/students/:studentId", (req, res) => {
  const { sessionCode, studentId } = req.params;
  const students = studentSessions[sessionCode] || [];
  const student = students.find((s) => s.id === studentId);

  if (!student) {
    return res.status(404).json({ error: "Student not found" });
  }

  res.json({
    name: student.name || "Unknown",
    code: student.code || "",
    output: student.output || "",
  });
});

// ------------------------ HEALTH CHECK ------------------------

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ------------------------ STUDENT JOIN SESSION ------------------------

app.post("/api/sessions/:sessionCode/join", (req, res) => {
  const { sessionCode } = req.params;
  const { name } = req.body;

  const status = sessionStatus[sessionCode];
  if (status && status.active === false) {
    return res.status(410).json({ error: "Session has ended" });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  const studentId = uuidv4();

  if (!studentSessions[sessionCode]) {
    studentSessions[sessionCode] = [];
  }

  studentSessions[sessionCode].push({
    id: studentId,
    name: name.trim(),
    code: "",
    output: "",
  });

  res.json({ studentId });
});

// ------------------------ NOTES & CODING SLIDES ------------------------

app.get("/api/sessions/:sessionCode/notes", (req, res) => {
  const { sessionCode } = req.params;
  const notesPath = path.join(__dirname, "slides", sessionCode, "notes.json");

  if (!fs.existsSync(notesPath)) {
    return res.status(404).json({ error: "Notes not found" });
  }

  const notes = JSON.parse(fs.readFileSync(notesPath, "utf-8"));
  res.json({ notes });
});

app.get("/api/sessions/:sessionCode/coding-slides", (req, res) => {
  const { sessionCode } = req.params;
  const notesPath = path.join(__dirname, "slides", sessionCode, "notes.json");

  if (!fs.existsSync(notesPath)) {
    return res.status(404).json({ error: "Notes not found" });
  }

  const notes = JSON.parse(fs.readFileSync(notesPath, "utf-8"));

  const codingSlides = notes.reduce((acc, note, index) => {
    if (typeof note === "string" && note.startsWith("Code Question:")) {
      acc.push(index);
    }
    return acc;
  }, []);

  res.json({ codingSlides });
});

// ------------------------ SESSION EXISTENCE ------------------------

app.get("/api/sessions/:sessionCode/exists", (req, res) => {
  const { sessionCode } = req.params;
  const sessionPath = path.join(__dirname, "slides", sessionCode);
  const exists = fs.existsSync(sessionPath);

  let active = sessionStatus[sessionCode]?.active;
  if (active === undefined) {
    const metaPath = path.join(sessionPath, "meta.json");
    if (exists && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        active = !meta.ended;
      } catch {
        active = true;
      }
    } else {
      active = exists;
    }
  }

  res.json({ exists, active });
});

// ------------------------ CLEANUP: SLIDES & TEMP ------------------------
const SLIDES_DIR = path.join(__dirname, "slides");
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });


// Tweak these as needed
const CLEAN_INTERVAL_MS   = 60 * 60 * 1000;          // run every hour
const MAX_SESSION_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // delete ended sessions older than 7 days
const TEMP_MAX_AGE_MS     = 24 * 60 * 60 * 1000;     // delete temp files older than 24 hours
const WS_PING_INTERVAL_MS = 30_000;
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
  });
}, WS_PING_INTERVAL_MS);

function msSince(dateLike) {
  const t = new Date(dateLike).getTime();
  return isNaN(t) ? Infinity : (Date.now() - t);
}

function safeRm(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    console.log("🧹 Deleted:", targetPath);
  } catch (e) {
    console.warn("⚠️ Failed to delete:", targetPath, e?.message);
  }
}

function cleanupSlides() {
  try {
    if (!fs.existsSync(SLIDES_DIR)) return;
    const entries = fs.readdirSync(SLIDES_DIR, { withFileTypes: true });

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;

      const sessionDir = path.join(SLIDES_DIR, ent.name);
      const metaPath   = path.join(sessionDir, "meta.json");

      // If no meta.json, fall back to directory mtime
      if (!fs.existsSync(metaPath)) {
        const stat = fs.statSync(sessionDir);
        const ageMs = Date.now() - stat.mtimeMs;
        // Be extra conservative if we don't know endedAt; skip unless VERY old
        if (ageMs > 30 * 24 * 60 * 60 * 1000) { // 30 days
          safeRm(sessionDir);
        }
        continue;
      }

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.ended && meta.endedAt && msSince(meta.endedAt) > MAX_SESSION_AGE_MS) {
          safeRm(sessionDir);
        }
      } catch (e) {
        // Corrupt meta.json — if dir is very old, remove it
        const stat = fs.statSync(sessionDir);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 30 * 24 * 60 * 60 * 1000) {
          safeRm(sessionDir);
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ cleanupSlides error:", e?.message);
  }
}

function cleanupTemp() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const entries = fs.readdirSync(TEMP_DIR, { withFileTypes: true });

    for (const ent of entries) {
      const p = path.join(TEMP_DIR, ent.name);
      try {
        const stat = fs.statSync(p);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > TEMP_MAX_AGE_MS) {
          if (ent.isDirectory()) safeRm(p);
          else safeRm(p);
        }
      } catch (e) {
        console.warn("⚠️ temp stat error:", p, e?.message);
      }
    }
  } catch (e) {
    console.warn("⚠️ cleanupTemp error:", e?.message);
  }
}

function runCleanupNow() {
  console.log("🧽 Running cleanup…");
  cleanupSlides();
  cleanupTemp();
}

function scheduleCleanup() {
  // initial pass
  runCleanupNow();
  // schedule
  setInterval(runCleanupNow, CLEAN_INTERVAL_MS);
}

// Start the cleaner (call this once after your app setup, before server.listen or right after)
scheduleCleanup();


// ------------------------ EDITOR LOCK ENDPOINTS ------------------------

app.get("/api/sessions/:sessionCode/lock", (req, res) => {
  const { sessionCode } = req.params;
  res.json({ locked: !!editorLocks[sessionCode] });
});

app.post("/api/sessions/:sessionCode/lock", (req, res) => {
  const { sessionCode } = req.params;
  const { locked } = req.body || {};
  editorLocks[sessionCode] = !!locked;

  // Broadcast to live clients
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(
        JSON.stringify({ type: "lock-editors", sessionCode, locked: !!locked })
      );
    }
  });

  res.json({ success: true, locked: !!locked });
});

// ------------------------ END SESSION ------------------------

app.post("/api/sessions/:sessionCode/end", (req, res) => {
  const { sessionCode } = req.params;
  const sessionDir = path.join(__dirname, "slides", sessionCode);
  if (!fs.existsSync(sessionDir))
    return res.status(404).json({ error: "Session not found" });

  const endedAt = new Date().toISOString();
  sessionStatus[sessionCode] = { active: false, endedAt };

  const metaPath = path.join(sessionDir, "meta.json");
  let meta = {};
  try {
    if (fs.existsSync(metaPath))
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {}
  meta.ended = true;
  meta.endedAt = endedAt;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // notify live clients
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({ type: "session-ended", sessionCode }));
    }
  });

  // clear server caches for this session
  delete studentSessions[sessionCode];
  delete editorLocks[sessionCode];
  delete sessionSlides[sessionCode];

  return res.json({ success: true });
});

// ------------------------ START SERVER ------------------------

server.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});
