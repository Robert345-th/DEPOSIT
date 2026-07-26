// ocr.js
// Runs OCR on a receipt photo and pulls out ONLY Customer ID and Code.
// Everything else on the slip (terminal, branch, amount, etc.) is ignored.
//
// Two passes:
//   1. Whole-photo OCR gets the Customer ID reliably, and a rough guess at
//      the Code via regex.
//   2. The Code field is small and easy to misread in full-page context, so
//      we locate it by POSITION (the value sitting right below the Customer
//      ID value, not by trying to read the word "Code" itself -- that label
//      is often garbled too) and re-OCR just that tiny region, zoomed in,
//      as a single word. This consistently produces a correctly-LENGTH
//      result even when 1-2 characters are still ambiguous (e.g. 8 vs B),
//      which is much faster to eyeball-correct than a garbled guess.

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
// changed between the two passes -- so only one scan runs at a time.
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

async function zoomedCodeRead(worker, image, wordBbox) {
  const pad = 20;
  const { x0, y0, x1, y1 } = wordBbox;
  const cropX = Math.max(0, x0 - pad);
  const cropY = Math.max(0, y0 - pad);
  const cropW = Math.min(image.bitmap.width - cropX, (x1 - x0) + pad * 2);
  const cropH = Math.min(image.bitmap.height - cropY, (y1 - y0) + pad * 2);

  const crop = image.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
  crop.resize({ w: cropW * 4 });

  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD,
    tessedit_char_whitelist: ALNUM_WHITELIST
  });
  const cropBuf = await crop.getBuffer('image/png');
  const { data } = await worker.recognize(cropBuf);
  return data.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
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

    // Second pass: zoom into just the Code value for a sharper read.
    // Only trust it if it comes back a plausible length -- otherwise keep
    // the first pass's guess rather than replace a decent answer with junk.
    const codeWord = findCodeWordCandidate(data.words || []);
    if (codeWord) {
      const zoomed = await zoomedCodeRead(worker, image, codeWord.bbox);
      if (zoomed.length >= 4 && zoomed.length <= 10) {
        code = zoomed;
      }
    }

    return { customer_id, code, raw_text: text };
  });
}

module.exports = { extractFromImage };
