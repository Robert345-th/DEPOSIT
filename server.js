// server.js
// Standalone Deposit OCR service.
//
// Flow:
//   1. POST /deposit/scan   -> photo dropped in "Deposit" box, OCR reads
//      Customer ID + Code, saved as status='pending'.
//   2. GET  /deposit/lookup?customer_id=X -> Tampermonkey script calls this
//      with the ID it found on the page. If a pending match exists, the
//      code is returned ONCE and the row flips to status='deposited'
//      (removed from the Deposit box, moved into the Deposited box).
//   3. GET  /deposit/pending / /deposit/deposited / /deposit/bin -> list views.
//   4. DELETE /deposit/:id moves a pending entry into the Bin (soft delete).
//      From the Bin it can be restored to Pending or deleted permanently.

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { pool, initDb } = require('./db');
const { extractFromImage } = require('./ocr');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Scan a receipt photo, add to the pending Deposit box ---
app.post('/deposit/scan', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded (field name: receipt)' });
    }

    const { customer_id, code, raw_text } = await extractFromImage(req.file.buffer);

    // Even if OCR couldn't read one or both fields, save it as pending so
    // the photo isn't lost -- fill in the blanks with Edit instead of
    // having to retake the photo from scratch.
    const result = await pool.query(
      `INSERT INTO deposits (customer_id, code, status, raw_text)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id, customer_id, code, status, created_at`,
      [customer_id, code, raw_text]
    );

    res.json({ ...result.rows[0], needs_review: !customer_id || !code });
  } catch (err) {
    console.error('scan error:', err);
    res.status(500).json({ error: 'Scan failed' });
  }
});

// --- Tampermonkey calls this with the Customer ID scraped from the page ---
app.get('/deposit/lookup', async (req, res) => {
  const { customer_id } = req.query;
  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id query param required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT id, code FROM deposits
       WHERE customer_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [customer_id]
    );

    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No pending code for this Customer ID' });
    }

    const row = found.rows[0];

    const updated = await client.query(
      `UPDATE deposits
       SET status = 'deposited', deposited_at = NOW()
       WHERE id = $1
       RETURNING customer_id, code, deposited_at`,
      [row.id]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  } finally {
    client.release();
  }
});

// --- List views for the UI boxes ---
app.get('/deposit/pending', async (req, res) => {
  const result = await pool.query(
    `SELECT id, customer_id, code, created_at FROM deposits
     WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100`
  );
  res.json(result.rows);
});

app.get('/deposit/deposited', async (req, res) => {
  const result = await pool.query(
    `SELECT id, customer_id, code, deposited_at FROM deposits
     WHERE status = 'deposited' ORDER BY deposited_at DESC LIMIT 100`
  );
  res.json(result.rows);
});

app.get('/deposit/bin', async (req, res) => {
  const result = await pool.query(
    `SELECT id, customer_id, code, removed_at FROM deposits
     WHERE status = 'removed' ORDER BY removed_at DESC LIMIT 100`
  );
  res.json(result.rows);
});

// --- Manual correction, in case OCR misreads a character ---
app.patch('/deposit/:id', async (req, res) => {
  const { customer_id, code } = req.body;
  const result = await pool.query(
    `UPDATE deposits SET
       customer_id = COALESCE($1, customer_id),
       code = COALESCE($2, code)
     WHERE id = $3 AND status = 'pending'
     RETURNING id, customer_id, code, status`,
    [customer_id || null, code ? code.toUpperCase() : null, req.params.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Not found or already deposited' });
  }
  res.json(result.rows[0]);
});

// --- Move a bad scan from Pending into the Bin (soft delete, recoverable) ---
app.delete('/deposit/:id', async (req, res) => {
  const result = await pool.query(
    `UPDATE deposits SET status = 'removed', removed_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [req.params.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Not found or not pending' });
  }
  res.json({ moved_to_bin: true });
});

// --- Put a binned entry back into Pending ---
app.post('/deposit/:id/restore', async (req, res) => {
  const result = await pool.query(
    `UPDATE deposits SET status = 'pending', removed_at = NULL
     WHERE id = $1 AND status = 'removed'
     RETURNING id, customer_id, code, status`,
    [req.params.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Not found or not in bin' });
  }
  res.json(result.rows[0]);
});

// --- Permanently delete something already in the Bin ---
app.delete('/deposit/:id/permanent', async (req, res) => {
  await pool.query(`DELETE FROM deposits WHERE id = $1 AND status = 'removed'`, [req.params.id]);
  res.json({ deleted: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Deposit OCR service running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
