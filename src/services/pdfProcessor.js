const fs = require("fs");
const path = require("path");

const SLIDES_DIR = path.join(__dirname, "../../slides");

/**
 * Convert a base64-encoded PDF into slide PNGs and write session metadata.
 * Returns the sessionCode (6-digit random number) on success.
 * @param {{ fileBase64: string, notes: string[], slidesUrl: string }} params
 */
async function processUpload({ fileBase64, notes, slidesUrl, language = "python" }) {
  let pdf;
  try {
    ({ pdf } = await import("pdf-to-img"));
    console.log("✅ pdf-to-img imported");
  } catch (importErr) {
    console.error("❌ Failed to import pdf-to-img:", importErr);
    throw importErr;
  }

  const sessionCode = String(Math.floor(100000 + Math.random() * 900000));
  const outputDir = path.join(SLIDES_DIR, sessionCode);
  fs.mkdirSync(outputDir, { recursive: true });

  const pdfBuffer = Buffer.from(fileBase64, "base64");
  const pdfPath = path.join(outputDir, `${sessionCode}.pdf`);
  fs.writeFileSync(pdfPath, pdfBuffer);
  console.log(`✅ PDF written: ${pdfPath} (${pdfBuffer.length} bytes)`);

  let counter = 1;
  try {
    const document = await pdf(pdfPath, { scale: 2 });
    for await (const image of document) {
      await fs.promises.writeFile(path.join(outputDir, `slide-${counter}.png`), image);
      counter++;
    }
    console.log(`✅ Converted ${counter - 1} slides`);
  } catch (convErr) {
    console.error("❌ PDF conversion error:", convErr);
    throw convErr;
  }

  const slideFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => `/slides/${sessionCode}/${f}`);

  fs.writeFileSync(path.join(outputDir, "notes.json"), JSON.stringify(notes, null, 2));
  fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify({ slides: slideFiles }, null, 2));
  fs.writeFileSync(path.join(outputDir, "meta.json"), JSON.stringify({ slidesUrl, language }, null, 2));

  console.log(`✅ Session ${sessionCode} created with ${counter - 1} slides`);
  return { sessionCode, slideCount: counter - 1 };
}

module.exports = { processUpload };
