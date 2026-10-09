// Code execution is delegated to the isolated CodeKiwi executor service
// (a Fly.io micro-VM). Student code NO LONGER runs on this backend host, so a
// memory/fork bomb can never crash the session/sync backend or a live class.
//
// Requires EXECUTOR_URL and EXECUTOR_SECRET env vars.

const EXECUTOR_URL = (process.env.EXECUTOR_URL || "").replace(/\/$/, "");
const EXECUTOR_SECRET = process.env.EXECUTOR_SECRET || "";
const EXECUTOR_TIMEOUT_MS = 25_000; // generous; the executor enforces its own wall-clock

const SUPPORTED = new Set(["python", "javascript", "java", "cpp"]);

// The executor could not run the program at all (busy, down, or unreachable).
// Distinct from program output so callers never grade it as a wrong answer.
class ExecutorUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutorUnavailable";
  }
}

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
    throw new ExecutorUnavailable("Code execution is temporarily unavailable. Please try again shortly.");
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
    if (res.status === 503) {
      throw new ExecutorUnavailable("Too many programs running right now. Try again in a few seconds.");
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`Executor responded ${res.status}: ${detail.slice(0, 200)}`);
      throw new ExecutorUnavailable("Code execution failed on the server. Try again in a moment.");
    }
    const data = await res.json();
    return data.output ?? "";
  } catch (err) {
    if (err instanceof ExecutorUnavailable) throw err;
    if (err.name === "AbortError") {
      throw new ExecutorUnavailable("The code runner is overloaded. Try again in a few seconds.");
    }
    console.error("Executor unreachable:", err.message);
    throw new ExecutorUnavailable("Code execution is temporarily unavailable. Please try again shortly.");
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { executeCode, ExecutorUnavailable, SUPPORTED, EXECUTOR_URL, EXECUTOR_SECRET };
