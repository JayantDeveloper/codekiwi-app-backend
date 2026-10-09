// Interactive runs: the student's terminal talks to their running program.
//
// The browser opens one WebSocket to /run per Run click. The first message is
// { type: "start", code, language, sessionCode, studentId, slideIndex, t? } and
// is checked by the same authorizeRun() as POST /api/run. The backend then
// opens its own socket to the executor's /interactive endpoint and relays:
//   browser -> { type: "input", data } (a typed line), { type: "eof" } (Ctrl+D),
//              { type: "stop" } (Ctrl+C)
//   backend -> { type: "started", compiling }, { type: "running" } once the program
//              (not the compiler) is running, { type: "out", data } as output streams,
//              { type: "grading" } while test cases run, then
//              { type: "exit", notice, grade, output } once, and closes.
//              { type: "error", message, retryable } if the run never starts.
// The browser never reaches the executor and never sees its secret.

const WebSocket = require("ws");
const { SUPPORTED, EXECUTOR_URL, EXECUTOR_SECRET } = require("../services/codeExecutor");
const { authorizeRun, gradeAndRecord } = require("../services/runAccess");
const { getTestsForSlide, testStdin } = require("../services/grader");

const START_TIMEOUT_MS = 30_000; // queued behind a busy executor this long at most
const MAX_TRANSCRIPT = 200_000;

function attachRunProxy(runWss) {
  runWss.on("connection", (client) => {
    let upstream = null;
    let started = false;
    let finished = false;
    let transcript = ""; // what the student's screen shows: output plus typed input
    let req = null;
    let isTeacher = false;
    let userStopped = false; // Stop / Ctrl+C, possibly while tests were running

    const send = (msg) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
    };
    const fail = (message, retryable = false) => {
      if (finished) return;
      finished = true;
      send({ type: "error", message, retryable });
      client.close();
      try { upstream?.close(); } catch {}
    };
    const append = (text) => {
      if (transcript.length < MAX_TRANSCRIPT) transcript += text.slice(0, MAX_TRANSCRIPT - transcript.length);
    };

    client.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "start" && !started) {
        started = true;
        const { code, language, sessionCode, studentId, slideIndex } = msg;
        if (!SUPPORTED.has(language)) return fail(`Unsupported language: ${language}`);
        const access = authorizeRun({ code, language, sessionCode: String(sessionCode || ""), studentId, teacherToken: msg.t });
        if (!access.ok) return fail(access.error, access.status === 429);
        if (!EXECUTOR_URL) return fail("Code execution is temporarily unavailable. Please try again shortly.", true);
        isTeacher = access.isTeacher;
        req = { sessionCode: String(sessionCode), studentId, slideIndex, code, language };
        console.log("📩 /run (interactive)", { language, sessionCode: req.sessionCode });

        upstream = new WebSocket(EXECUTOR_URL.replace(/^http/, "ws") + "/interactive", {
          headers: { "x-executor-secret": EXECUTOR_SECRET },
        });
        const startTimer = setTimeout(() => fail("The code runner is overloaded. Try again in a few seconds.", true), START_TIMEOUT_MS);
        // Students on a graded slide: the executor runs the slide's tests right
        // after their program, reusing its compiled binary.
        const spec = !isTeacher && Number.isInteger(slideIndex) ? getTestsForSlide(req.sessionCode, slideIndex) : null;
        const tests = spec ? spec.tests.map((t) => ({ input: testStdin(t.input) })) : undefined;
        upstream.on("open", () => upstream.send(JSON.stringify({ type: "start", code, language, tests })));
        upstream.on("message", async (data) => {
          let m;
          try {
            m = JSON.parse(data);
          } catch {
            return;
          }
          if (m.type === "started") {
            clearTimeout(startTimer);
            send({ type: "started", compiling: !!m.compiling });
          } else if (m.type === "running") {
            send({ type: "running" });
          } else if (m.type === "grading") {
            send({ type: "grading" });
          } else if (m.type === "out") {
            append(m.data);
            send({ type: "out", data: m.data });
          } else if (m.type === "busy") {
            clearTimeout(startTimer);
            fail(m.message || "Too many programs running right now. Try again in a few seconds.", true);
          } else if (m.type === "exit") {
            clearTimeout(startTimer);
            if (finished) return;
            finished = true;
            const output = m.notice ? (transcript ? transcript.replace(/\n?$/, "\n") : "") + m.notice : transcript;
            // Teacher demo runs just execute and return: nothing to grade or record.
            // A run the student stopped themselves (Ctrl+C / Stop) isn't an attempt.
            const stopped = userStopped || (m.notice || "").startsWith("^C");
            // Exit status is unknown when the executor itself ended the run
            // (idle timeout, output cap); grading then sniffs the output.
            const crashed = Number.isInteger(m.exitCode) ? m.exitCode !== 0 : undefined;
            let grade = { graded: false, stopped };
            if (!isTeacher && !stopped) grade = await gradeAndRecord({ ...req, output, crashed, testRun: m.tests });
            send({ type: "exit", notice: m.notice || "", grade, output });
            client.close();
          }
        });
        upstream.on("error", (err) => {
          clearTimeout(startTimer);
          console.error("Executor (interactive) unreachable:", err.message);
          fail("Code execution is temporarily unavailable. Please try again shortly.", true);
        });
        upstream.on("close", () => {
          clearTimeout(startTimer);
          fail("The code runner disconnected. Try running again.", true);
        });
        return;
      }

      if (!upstream || upstream.readyState !== WebSocket.OPEN || finished) return;
      if (msg.type === "input" && typeof msg.data === "string") {
        append(msg.data);
        upstream.send(JSON.stringify({ type: "input", data: msg.data }));
      } else if (msg.type === "eof" || msg.type === "stop") {
        if (msg.type === "stop") userStopped = true;
        upstream.send(JSON.stringify({ type: msg.type }));
      }
    });

    // Student closed the tab or navigated away: stop their program.
    client.on("close", () => {
      finished = true;
      try { upstream?.close(); } catch {}
    });
    client.on("error", () => {});
  });
}

module.exports = { attachRunProxy };
