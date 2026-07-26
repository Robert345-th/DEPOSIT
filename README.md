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
- `public/index.html` — the drop box UI + live pending/deposited lists
- `tampermonkey-example.js` — starter userscript that calls `/deposit/lookup`

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
`8`/`B` and `6`/`E` can get misread, especially on curved paper or with
glare/clutter in the frame. The scan does two passes: first it reads the
whole photo (reliable for the Customer ID), then it locates the Code value
by *position* (the value sitting right below the Customer ID -- not by
trying to read the word "Code" itself, since that label is often garbled
too) and re-reads just that small region zoomed in, as a single word.

Tested against real receipts: this consistently produces a Code guess of
the *correct length*, usually off by only one character (typically an
8-vs-B mix-up) rather than the wrong length entirely. On a blurry or
poorly-lit photo, even the Customer ID digits can come out wrong -- that's
a real limit of the photo itself, not something the algorithm can reason
around. Tap **Edit** on any pending ticket to fix a misread character in
seconds. Flatter, well-lit, uncluttered photos of just the receipt still
give the most reliable reads.

If a photo is too unclear to read anything at all, it still gets added to
Pending (rather than being thrown away) with blank fields and an orange
**Needs review** stamp instead of the usual Pending one -- tap **Edit** to
fill in the Customer ID and Code by hand from the same photo. Nothing is
ever lost to a failed scan; you just may need to type it in yourself.
