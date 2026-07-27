// ocr.js
// Runs OCR on a receipt photo and pulls out ONLY Customer ID and Code.
// Everything else on the slip (terminal, branch, amount, etc.) is ignored.
//
// Passes:
//   1. Whole-photo OCR gets the Customer ID reliably, and a rough guess at
//      the Code via regex.
//   2. The Code field is small and easy to misread in full-page context, so
//      we locate it by POSITION (the value sitting right below the Customer
//      ID value, not by trying to read the word "Code" itself -- that label
//      is often garbled too), crop just that tiny region, and re-OCR it
//      zoomed in, three times with slightly different crop padding / page
//      segmentation settings. If two of the three attempts agree exactly,
//      the result is trusted as confident. If all three disagree, the best
//      single attempt is still used as a starting guess, but the entry is
//      flagged "needs review" -- the disagreement itself is the signal that
//      this particular read is uncertain, even when something was read.

const Tesseract = require('tesseract.js');
const { Jimp } = require('jimp');

// Matches "Customer ID: 1023779". The separator after the label is loose
// because OCR often misreads the colon as !, l, |, etc.
const ID_PATTERN = /Customer\s*ID\s*[^0-9A-Za-z]{0,3}\s*(\d{4,12})/i;

// Matches "Code: EB8T6" -- alphanumeric, 4-10 chars
const CODE_PATTERN = /\bCode\s*[^0-9A-Za-z]{0,3}\s*([A-Z0-9]{4,10})\b/i;

const FULL_PAGE_WHITELIST =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:.- ';
const ALNUM_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Three independent settings to re-read the same tiny crop with. Testing
// against real receipts showed tighter padding + single-word mode performs
// best on average, so it's listed first and used as the primary guess.
const CODE_READ_VARIANTS = [
  { pad: 15, psm: () => Tesseract.PSM.SINGLE_WORD },
  { pad: 25, psm: () => Tesseract.PSM.SINGLE_WORD },
  { pad: 20, psm: () => Tesseract.PSM.SINGLE_LINE }
];

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

// The worker is a shared singleton, and its parameters (whitelist, PSM) get
// changed between passes -- so only one scan runs at a time.
let queue = Promise.resolve();
function withLock(fn) {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

// Light cleanup only. Testing against real receipt photos showed that
// aggressive contrast/normalize/upscaling actively hurts accuracy on
// blurry or curved thermal-paper shots -- plain grayscale performs best.
async function preprocess(buffer) {
  const image = await Jimp.read(buffer);
  image.greyscale();
  return image;
}

// Finds the Customer ID value word, then the nearest word below it in a
// similar horizontal position -- that's the Code value, regardless of
// whether the "Code" label itself was read correctly.
function findCodeWordCandidate(words) {
  const idWord = words.find((w) => /^\d{4,12}$/.test(w.text));
  if (!idWord) return null;

  const below = words
    .filter((w) => w.bbox.y0 > idWord.bbox.y1 && w.bbox.y0 < idWord.bbox.y1 + 150)
    .filter((w) => Math.abs(w.bbox.x0 - idWord.bbox.x0) < 200)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);

  return below[0] || null;
}

async function readCropVariant(worker, image, wordBbox, pad, psm) {
  const { x0, y0, x1, y1 } = wordBbox;
  const cropX = Math.max(0, x0 - pad);
  const cropY = Math.max(0, y0 - pad);
  const cropW = Math.min(image.bitmap.width - cropX, (x1 - x0) + pad * 2);
  const cropH = Math.min(image.bitmap.height - cropY, (y1 - y0) + pad * 2);

  const crop = image.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
  crop.resize({ w: cropW * 4 });

  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    tessedit_char_whitelist: ALNUM_WHITELIST
  });
  const cropBuf = await crop.getBuffer('image/png');
  const { data } = await worker.recognize(cropBuf);
  return data.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

// Runs three re-reads of the Code crop. Returns the primary (best-performing
// variant's) guess, plus whether a second attempt confirmed it exactly.
async function zoomedCodeReadWithConfidence(worker, image, wordBbox) {
  const attempts = [];
  for (const variant of CODE_READ_VARIANTS) {
    const result = await readCropVariant(worker, image, wordBbox, variant.pad, variant.psm());
    if (result.length >= 4 && result.length <= 10) attempts.push(result);
  }

  if (attempts.length === 0) return { code: null, confident: false };

  const primary = attempts[0];
  const confirmed = attempts.slice(1).some((a) => a === primary);
  return { code: primary, confident: confirmed };
}

async function extractFromImage(buffer) {
  return withLock(async () => {
    const image = await preprocess(buffer);
    const worker = await getWorker();

    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.AUTO,
      tessedit_char_whitelist: FULL_PAGE_WHITELIST
    });
    const fullBuf = await image.getBuffer('image/png');
    const { data } = await worker.recognize(fullBuf);
    const text = data.text || '';

    const idMatch = text.match(ID_PATTERN);
    const codeMatch = text.match(CODE_PATTERN);

    // The "ID" label itself sometimes gets misread (e.g. "1D" instead of
    // "ID"), which breaks a text-based match even though the digits next
    // to it read fine. Prefer the digit word found directly, same as the
    // Code lookup does -- fall back to the label regex only if that fails.
    const idWord = (data.words || []).find((w) => /^\d{4,12}$/.test(w.text));
    const customer_id = idWord ? idWord.text : (idMatch ? idMatch[1] : null);
    let code = codeMatch ? codeMatch[1].toUpperCase() : null;
    let codeConfident = false;

    const codeWord = findCodeWordCandidate(data.words || []);
    if (codeWord) {
      const zoomed = await zoomedCodeReadWithConfidence(worker, image, codeWord.bbox);
      if (zoomed.code) {
        code = zoomed.code;
        codeConfident = zoomed.confident;
      }
    }

    return { customer_id, code, code_confident: codeConfident, raw_text: text };
  });
}

module.exports = { extractFromImage };
