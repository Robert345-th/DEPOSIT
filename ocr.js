// ocr.js
// Runs OCR on a receipt photo and pulls out ONLY Customer ID and Code.
// Everything else on the slip (terminal, branch, amount, etc.) is ignored.

const Tesseract = require('tesseract.js');

// Matches "Customer ID: 1023779". The separator after the label is loose
// because OCR often misreads the colon as !, l, |, etc.
const ID_PATTERN = /Customer\s*ID\s*[^0-9A-Za-z]{0,3}\s*(\d{4,12})/i;

// Matches "Code: EB8T6" -- alphanumeric, 4-10 chars
const CODE_PATTERN = /\bCode\s*[^0-9A-Za-z]{0,3}\s*([A-Z0-9]{4,10})\b/i;

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      // Default CDN (jsdelivr) can throttle/403 in some hosting environments.
      // This GitHub-hosted mirror is more reliable.
      langPath: 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best',
      cachePath: '/tmp/tess-cache',
      gzip: true
    });
  }
  return workerPromise;
}

async function extractFromImage(buffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  const text = data.text || '';

  const idMatch = text.match(ID_PATTERN);
  const codeMatch = text.match(CODE_PATTERN);

  return {
    customer_id: idMatch ? idMatch[1] : null,
    code: codeMatch ? codeMatch[1].toUpperCase() : null,
    raw_text: text
  };
}

module.exports = { extractFromImage };
