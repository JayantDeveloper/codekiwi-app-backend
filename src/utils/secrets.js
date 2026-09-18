const crypto = require("crypto");

// Shared secrets are required, never optional. A missing value used to make the
// guards `if (secret && ...)` silently pass every request, which left the
// teacher-token and upload routes open in production. Fail at boot instead.
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} must be set (refusing to start with an open auth gate)`);
  }
  return v;
}

// Constant-time string comparison; false on length mismatch or non-strings.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Express guard for routes only the add-on / site may call.
function requireSharedSecret(req, res) {
  if (!safeEqual(req.headers["x-codekiwi-secret"], process.env.APPSCRIPT_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

module.exports = { requireEnv, safeEqual, requireSharedSecret };
