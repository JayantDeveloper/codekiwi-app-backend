// Code execution is delegated to the isolated CodeKiwi executor service
// (a Fly.io micro-VM). Student code NO LONGER runs on this backend host, so a
// memory/fork bomb can never crash the session/sync backend or a live class.
//
// Requires EXECUTOR_URL and EXECUTOR_SECRET env vars.

const EXECUTOR_URL = (process.env.EXECUTOR_URL || "").replace(/\/$/, "");
const EXECUTOR_SECRET = process.env.EXECUTOR_SECRET || "";
const EXECUTOR_TIMEOUT_MS = 20_000; // generous; the executor enforces its own 10s

const SUPPORTED = new Set(["python", "javascript"]);

/**
 * Run user code on the isolated executor service and return its output.
 * @param {{ code: string, language: string }} params
 * @returns {Promise<string>}
 */
async function executeCode({ code, language }) {
  if (!SUPPORTED.has(language)) {
    throw new Error(`Unsupported language: ${language}`);
  }
  if (!EXECUTOR_URL) {
    console.warn("EXECUTOR_URL not configured — code execution unavailable");
    return "Code execution is temporarily unavailable. Please try again shortly.";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);
  try {
    const res = await fetch(`${EXECUTOR_URL}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-executor-secret": EXECUTOR_SECRET,
      },
      body: JSON.stringify({ code, language }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Executor responded ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.output ?? "";
  } catch (err) {
    if (err.name === "AbortError") {
      return "⏰ Execution timed out.";
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { executeCode };
