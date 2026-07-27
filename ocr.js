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
//      FIVE times: three variants of crop padding / page segmentation, plus
//      two black-and-white threshold levels (binarization sometimes clears
//      up a character a grayscale read gets wrong, and vice versa).
//
//      Rather than requiring the whole string to match across attempts, we
//      vote CHARACTER BY CHARACTER. A position is only trusted if at least
//      two attempts agree on that specific character; if every attempt
//      disagrees at some position, that position (and the whole code) is
//      flagged "needs review" even though a best-guess is still filled in.
//
//      Real limit, and worth being honest about: if every attempt makes
//      the *same* mistake (e.g. a particular Q reliably renders in a way
//      that looks like O at this font/resolution), voting won't catch it --
//      that's a systematic misread, not noise, and no amount of re-reading
//      the same pixels fixes it. This approach catches inconsistent
//      mistakes, which is most of them, not consistent ones.

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

// Five independent re-reads of the same tiny Code crop. `thresh: null` means
// plain grayscale; otherwise the crop is binarized to pure black/white at
// that cutoff first.
const CODE_READ_VARIANTS = [
  { pad: 15, psm: () => Tesseract.PSM.SINGLE_WORD, thresh: null },
  { pad: 25, psm: () => Tesseract.PSM.SINGLE_WORD, thresh: null },
  { pad: 20, psm: () => Tesseract.PSM.SINGLE_LINE, thresh: null },
  { pad: 15, psm: () => Tesseract.PSM.SINGLE_WORD, thresh: 140 },
  { pad: 15, psm: () => Tesseract.PSM.SINGLE_WORD, thresh: 170 }
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

async function readCropVariant(worker, image, wordBbox, variant) {
  const { x0, y0, x1, y1 } = wordBbox;
  const cropX = Math.max(0, x0 - variant.pad);
  const cropY = Math.max(0, y0 - variant.pad);
  const cropW = Math.min(image.bitmap.width - cropX, (x1 - x0) + variant.pad * 2);
  const cropH = Math.min(image.bitmap.height - cropY, (y1 - y0) + variant.pad * 2);

  const crop = image.clone().crop({ x: cropX, y: cropY, w: cropW, h: cropH });
  crop.resize({ w: cropW * 4 });
  if (variant.thresh !== null) crop.threshold({ max: variant.thresh });

  await worker.setParameters({
    tessedit_pageseg_mode: variant.psm(),
    tessedit_char_whitelist: ALNUM_WHITELIST
  });
  const cropBuf = await crop.getBuffer('image/png');
  const { data } = await worker.recognize(cropBuf);
  return data.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

// Character groups that are commonly confused with each other on small,
// low-resolution, or faded print -- even by a human eye, let alone OCR.
// If the final code contains any of these characters, unanimous agreement
// across all 5 read attempts still doesn't prove correctness, because every
// attempt can independently make the exact same misread of the same glyph
// shape (this is the failure mode voting alone can't catch).
//
// Kept deliberately narrow to pairs actually observed failing on real
// receipts (O/Q, 5/S, 8/B, 6/G) -- a broader "everything that could ever be
// confused" list would flag nearly every code and make the flag useless.
const CONFUSABLE_GROUPS = [
  ['0', 'O', 'Q'],
  ['5', 'S'],
  ['8', 'B'],
  ['6', 'G'],
];
const CONFUSABLE_CHARS = new Set(CONFUSABLE_GROUPS.flat());

// Builds a composite code by voting character-by-character across whichever
// attempts share the most common length. A position needs at least 2 votes
// to be trusted; if even one position never gets 2 votes, the whole code
// is marked not confident (but the best-guess composite is still returned).
// Separately, if any character in the result belongs to a commonly-confused
// group, confidence is capped regardless of vote agreement -- see comment
// on CONFUSABLE_GROUPS above.
function buildConsensus(attempts) {
  const valid = attempts.filter((s) => s.length >= 4 && s.length <= 10);
  if (valid.length === 0) return { code: null, confident: false, ambiguousPositions: [] };

  const lengthCounts = {};
  valid.forEach((s) => { lengthCounts[s.length] = (lengthCounts[s.length] || 0) + 1; });
  const dominantLength = Number(
    Object.entries(lengthCounts).sort((a, b) => b[1] - a[1])[0][0]
  );
  const group = valid.filter((s) => s.length === dominantLength);

  let composite = '';
  let confident = group.length >= 2;
  const ambiguousPositions = [];
  for (let i = 0; i < dominantLength; i++) {
    const counts = {};
    group.forEach((s) => { counts[s[i]] = (counts[s[i]] || 0) + 1; });
    const [bestChar, bestCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    composite += bestChar;
    if (bestCount < 2) confident = false;
    if (CONFUSABLE_CHARS.has(bestChar)) {
      confident = false;
      ambiguousPositions.push(i);
    }
  }

  return { code: composite, confident, ambiguousPositions };
}

async function zoomedCodeReadWithConfidence(worker, image, wordBbox) {
  const attempts = [];
  for (const variant of CODE_READ_VARIANTS) {
    attempts.push(await readCropVariant(worker, image, wordBbox, variant));
  }
  return buildConsensus(attempts);
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
