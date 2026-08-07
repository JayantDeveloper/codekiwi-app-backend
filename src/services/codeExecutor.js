const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const TEMP_DIR = path.join(__dirname, "../../temp");

const EXECUTION_TIMEOUT_MS = 10_000; // wall-clock kill
const MAX_OUTPUT_BYTES = 100_000; // cap captured stdout/stderr
const MAX_CONCURRENT = 8; // global cap on simultaneous executions

// Each language's raw command runs inside execDir (relative filenames), wrapped
// in a shell that first applies resource limits. `ulimitExtra` holds an
// address-space cap for interpreters that tolerate it (Python); V8 (node) and
// the JVM (java) refuse to start under a tight `ulimit -v`, so it is omitted there.
const LANG_CONFIG = {
  python: {
    extension: "py",
    ulimitExtra: "ulimit -v 786432; ", // ~768MB address space -> stops memory bombs
    command: "python3 -u Main.py",
  },
  javascript: {
    extension: "js",
    ulimitExtra: "",
    command: "node Main.js",
  },
  java: {
    extension: "java",
    ulimitExtra: "",
    command: "javac Main.java && java -cp . Main",
  },
};

// Scrubbed environment: student code must NOT inherit the server's secrets.
const SANDBOX_ENV = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
};

// ── global concurrency limiter ────────────────────────────────────────────────
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}

/**
 * Execute user code in a resource-limited, secret-free subprocess and return the
 * combined stdout/stderr. Rejects with an Error if the language is unsupported.
 * @param {{ code: string, language: string }} params
 * @returns {Promise<string>}
 */
async function executeCode({ code, language }) {
  const config = LANG_CONFIG[language];
  if (!config) throw new Error(`Unsupported language: ${language}`);

  await acquire();

  return new Promise((resolve) => {
    const { extension, command, ulimitExtra } = config;
    const execId = uuidv4();
    const execDir = path.join(TEMP_DIR, execId);
    const filePath = path.join(execDir, `Main.${extension}`);

    let settled = false;
    let child = null;

    const cleanup = () => {
      try {
        fs.rmSync(execDir, { recursive: true, force: true });
      } catch {}
    };
    const killGroup = () => {
      try {
        if (child && child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      release();
      resolve(text);
    };

    // Declared before use inside finish; assigned below.
    let timer;

    try {
      fs.mkdirSync(execDir, { recursive: true });
      fs.writeFileSync(filePath, code, "utf8");

      // nproc cap is a fork-bomb backstop. It is per-UID, so the value must sit
      // comfortably above the container's baseline process/thread count. Tunable
      // via CK_ULIMIT_NPROC (set to 0 to disable, e.g. on dev machines whose user
      // already exceeds the cap). Default 512 suits the Render container.
      const nproc = Number(process.env.CK_ULIMIT_NPROC ?? "512");
      const limits =
        "ulimit -t 10; " + // CPU seconds
        "ulimit -f 20480; " + // max written file size
        (nproc > 0 ? `ulimit -u ${nproc}; ` : "") + // max processes (fork-bomb backstop)
        ulimitExtra;

      child = spawn("sh", ["-c", `${limits}${command}`], {
        cwd: execDir,
        env: SANDBOX_ENV,
        detached: true, // own process group so descendants can be killed together
      });
    } catch (err) {
      finish("Failed to run code: " + err.message);
      return;
    }

    let output = "";
    let truncated = false;

    timer = setTimeout(() => {
      killGroup();
      finish((output ? output + "\n" : "") + "⏰ Execution timed out (possible infinite loop)");
    }, EXECUTION_TIMEOUT_MS);

    const onData = (d) => {
      if (truncated) return;
      output += d.toString();
      if (output.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        output = output.slice(0, MAX_OUTPUT_BYTES) + "\n⚠️ Output truncated (limit reached).";
        killGroup();
        finish(output);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      killGroup();
      finish("Failed to run code: " + err.message);
    });
    child.on("close", () => finish(output));
  });
}

module.exports = { executeCode, LANG_CONFIG };
