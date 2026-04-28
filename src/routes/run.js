const express = require("express");
const { executeCode } = require("../services/codeExecutor");

const router = express.Router();

router.post("/api/run", async (req, res) => {
  const { code, language } = req.body;
  console.log("📩 Incoming /api/run request, language:", language);

  if (!code || !language) {
    return res.status(400).json({ error: "Invalid code or language" });
  }

  try {
    const output = await executeCode({ code, language });
    res.json({ output });
  } catch (err) {
    console.warn("❗ Run error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
