const fs = require("fs");
const path = require("path");
const https = require("https");

const SLIDES_DIR = path.join(__dirname, "../../slides");

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch slide image: HTTP ${res.statusCode}`));
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Fetch slide thumbnail images from Google and write session metadata.
 * Returns the sessionCode (6-digit random number) on success.
 * @param {{ thumbnailUrls: string[], notes: string[], slidesUrl: string, language: string }} params
 */
async function processUpload({ thumbnailUrls, notes, slidesUrl, language = "python" }) {
  const sessionCode = String(Math.floor(100000 + Math.random() * 900000));
  const outputDir = path.join(SLIDES_DIR, sessionCode);
  fs.mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < thumbnailUrls.length; i++) {
    const imageBuffer = await fetchUrl(thumbnailUrls[i]);
    await fs.promises.writeFile(path.join(outputDir, `slide-${i + 1}.png`), imageBuffer);
  }
  console.log(`✅ Fetched and saved ${thumbnailUrls.length} slide images for session ${sessionCode}`);

  const slideFiles = thumbnailUrls.map((_, i) => `/slides/${sessionCode}/slide-${i + 1}.png`);

  fs.writeFileSync(path.join(outputDir, "notes.json"), JSON.stringify(notes, null, 2));
  fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify({ slides: slideFiles }, null, 2));
  fs.writeFileSync(path.join(outputDir, "meta.json"), JSON.stringify({ slidesUrl, language }, null, 2));

  console.log(`✅ Session ${sessionCode} created with ${thumbnailUrls.length} slides`);
  return { sessionCode, slideCount: thumbnailUrls.length };
}

module.exports = { processUpload };
