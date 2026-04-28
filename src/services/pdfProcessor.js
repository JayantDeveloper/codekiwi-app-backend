const fs = require("fs");
const path = require("path");

const SLIDES_DIR = path.join(__dirname, "../../slides");

/**
 * Convert a base64-encoded PDF into slide PNGs and write session metadata.
 * Returns the sessionCode (timestamp-based ID) on success.
 * @param {{ fileBase64: string, notes: string[], slidesUrl: string }} params
 */
async function processUpload({ fileBase64, notes, slidesUrl }) {
  const { pdf } = await import("pdf-to-img");

  const sessionCode = Date.now().toString();
  const outputDir = path.join(SLIDES_DIR, sessionCode);
  fs.mkdirSync(outputDir, { recursive: true });

  const pdfBuffer = Buffer.from(fileBase64, "base64");
  const pdfPath = path.join(outputDir, `${sessionCode}.pdf`);
  fs.writeFileSync(pdfPath, pdfBuffer);

  const document = await pdf(pdfPath, { scale: 3 });
  let counter = 1;
  for await (const image of document) {
    await fs.promises.writeFile(path.join(outputDir, `slide-${counter}.png`), image);
    counter++;
  }

  const slideFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => `/slides/${sessionCode}/${f}`);

  fs.writeFileSync(path.join(outputDir, "notes.json"), JSON.stringify(notes, null, 2));
  fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify({ slides: slideFiles }, null, 2));
  fs.writeFileSync(path.join(outputDir, "meta.json"), JSON.stringify({ slidesUrl }, null, 2));

  console.log(`✅ Session ${sessionCode} created with ${counter - 1} slides`);
  return { sessionCode, slideCount: counter - 1 };
}

module.exports = { processUpload };
