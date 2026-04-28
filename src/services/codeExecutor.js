const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const TEMP_DIR = path.join(__dirname, "../../temp");

const LANG_CONFIG = {
  python: {
    extension: "py",
    getSpawn: (filePath) => spawn("python3", ["-u", filePath]),
  },
  javascript: {
    extension: "js",
    getSpawn: (filePath) => spawn("node", [filePath]),
  },
  java: {
    extension: "java",
    getSpawn: (filePath, execDir) =>
      spawn("sh", ["-c", `javac "${filePath}" && java -cp "${execDir}" Main`]),
  },
};

const EXECUTION_TIMEOUT_MS = 10_000;

/**
 * Execute user code and return the combined stdout/stderr output.
 * Rejects with an Error if the language is unsupported.
 * @param {{ code: string, language: string }} params
 * @returns {Promise<string>}
 */
function executeCode({ code, language }) {
  return new Promise((resolve, reject) => {
    const config = LANG_CONFIG[language];
    if (!config) {
      reject(new Error(`Unsupported language: ${language}`));
      return;
    }

    const { extension, getSpawn } = config;
    const execId = uuidv4();
    const execDir = path.join(TEMP_DIR, execId);
    const filePath = path.join(execDir, `Main.${extension}`);

    fs.mkdirSync(execDir, { recursive: true });
    fs.writeFileSync(filePath, code, "utf8");

    const child = getSpawn(filePath, execDir);
    let output = "";
    let settled = false;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(execDir, { recursive: true, force: true }); } catch {}
      resolve(text);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      console.log("⛔ Execution timed out");
      finish("⏰ Execution timed out (possible infinite loop)");
    }, EXECUTION_TIMEOUT_MS);

    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("error", (err) => {
      console.error("❌ Spawn error:", err);
      finish("Failed to run code: " + err.message);
    });
    child.on("close", (exitCode) => {
      console.log(exitCode === 0 ? "✅ Execution success" : `❌ Process exited with code ${exitCode}`);
      finish(output);
    });
  });
}

module.exports = { executeCode, LANG_CONFIG };
