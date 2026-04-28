const fs = require("fs");
const path = require("path");

const SLIDES_DIR = path.join(__dirname, "../../slides");
const TEMP_DIR = path.join(__dirname, "../../temp");

const CLEAN_INTERVAL_MS = 60 * 60 * 1000;         // every hour
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for ended sessions
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;      // 24 hours for temp files
const FALLBACK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days if no meta

function msSince(dateLike) {
  const t = new Date(dateLike).getTime();
  return isNaN(t) ? Infinity : Date.now() - t;
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
  if (!fs.existsSync(SLIDES_DIR)) return;
  const entries = fs.readdirSync(SLIDES_DIR, { withFileTypes: true });

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sessionDir = path.join(SLIDES_DIR, ent.name);
    const metaPath = path.join(sessionDir, "meta.json");

    if (!fs.existsSync(metaPath)) {
      const ageFallback = Date.now() - fs.statSync(sessionDir).mtimeMs;
      if (ageFallback > FALLBACK_MAX_AGE_MS) safeRm(sessionDir);
      continue;
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.ended && meta.endedAt && msSince(meta.endedAt) > MAX_SESSION_AGE_MS) {
        safeRm(sessionDir);
      }
    } catch {
      const ageFallback = Date.now() - fs.statSync(sessionDir).mtimeMs;
      if (ageFallback > FALLBACK_MAX_AGE_MS) safeRm(sessionDir);
    }
  }
}

function cleanupTemp() {
  if (!fs.existsSync(TEMP_DIR)) return;
  const entries = fs.readdirSync(TEMP_DIR, { withFileTypes: true });

  for (const ent of entries) {
    const p = path.join(TEMP_DIR, ent.name);
    try {
      const ageMs = Date.now() - fs.statSync(p).mtimeMs;
      if (ageMs > TEMP_MAX_AGE_MS) safeRm(p);
    } catch (e) {
      console.warn("⚠️ temp stat error:", p, e?.message);
    }
  }
}

function scheduleCleanup() {
  const run = () => {
    console.log("🧽 Running cleanup…");
    try { cleanupSlides(); } catch (e) { console.warn("⚠️ cleanupSlides error:", e?.message); }
    try { cleanupTemp(); } catch (e) { console.warn("⚠️ cleanupTemp error:", e?.message); }
  };
  run();
  setInterval(run, CLEAN_INTERVAL_MS);
}

module.exports = { msSince, safeRm, scheduleCleanup, TEMP_DIR };
