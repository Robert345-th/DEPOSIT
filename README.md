# Deposit OCR App

Drop a photo of a deposit receipt into the "Deposit box" (web page). It OCRs
the image, pulls out only the **Customer ID** and **Code**, and saves it as
`pending`. A Tampermonkey script running on the betting site later asks the
server "got a code for this Customer ID?" — if found, the server hands the
code back **once** and moves that record from the pending Deposit box into
the Deposited box, so it can never be reused.

## Files

- `server.js` — Express app, all endpoints
- `db.js` — Postgres connection + table setup (own database, separate from
  your other pool servers — do NOT point this at the shared pool1-4 schema)
- `ocr.js` — Tesseract OCR + regex extraction of Customer ID / Code only
- `public/index.html` — the ticket-styled drop box UI + live pending/claimed lists
- `public/manifest.json`, `public/sw.js`, `public/icons/` — PWA install support
- `tampermonkey-example.js` — starter userscript that calls `/deposit/lookup`

## Installing as an app (PWA)

Once deployed, open the Railway URL on your phone in Chrome:
- Tap the browser menu → **Add to Home screen** / **Install app**
- It installs with its own icon and launches full-screen, no browser chrome

This works because `manifest.json` + `sw.js` are already wired into `index.html`.

## Deploy to Railway

1. Push this folder to a new GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Add a **PostgreSQL** plugin to the same Railway project. Railway will
   automatically inject `DATABASE_URL` into your app's environment — you
   don't need to set it manually.
4. Deploy. On first boot the app creates the `deposits` table itself.
5. Open the Railway-generated URL — you'll see the Deposit box UI.

## Endpoints

| Method | Path                          | What it does |
|--------|-------------------------------|---------------|
| POST   | `/deposit/scan`               | Upload a receipt photo (`multipart/form-data`, field `receipt`) → OCR → saves as pending |
| GET    | `/deposit/lookup?customer_id=X` | Returns the code for that ID once, marks it deposited |
| GET    | `/deposit/pending`             | List pending (Deposit box) entries |
| GET    | `/deposit/deposited`           | List deposited entries |
| PATCH  | `/deposit/:id`                 | Manually fix a misread `customer_id` or `code` while still pending |
| DELETE | `/deposit/:id`                 | Remove a bad pending scan |

## Tampermonkey side

Edit `tampermonkey-example.js`:
- Set `SERVER_URL` to your Railway app URL
- Update `@connect` to match your Railway domain
- Wire `exampleFlow()` (or your own version) into wherever your script
  currently reads the Customer ID off the page

## A note on accuracy

OCR on phone photos of thermal receipts isn't perfect — characters like
`8`/`B` and `6`/`G` can get misread, especially on curved paper or with
glare/clutter in the frame. I tested several image preprocessing strategies
against a real sample receipt (contrast boost, upscaling, normalization) —
counterintuitively, they made accuracy *worse* on blurry/curved shots, so
the pipeline uses light grayscale-only cleanup. Customer ID reads reliably;
the Code occasionally needs a manual fix, which you can now do right in the
UI — tap **Edit** on any pending ticket. Flatter, well-lit, uncluttered
photos of just the receipt will still reduce errors the most.
