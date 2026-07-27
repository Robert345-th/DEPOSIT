// db.js
// Connects to this app's OWN Postgres database (Railway Postgres plugin
// attached to THIS service). Do not point this at the shared pool1-4
// database used by login-pool-server / aviator-server -- keep it separate.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      customer_id TEXT,
      code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_text TEXT,
      needs_review BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deposited_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposits_customer_status
    ON deposits (customer_id, status);
  `);
  // Migrations for older deployments:
  await pool.query(`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;`);
  // A scan that fails to read anything still gets saved (for manual entry),
  // so these can no longer be NOT NULL on tables created before this change.
  await pool.query(`ALTER TABLE deposits ALTER COLUMN customer_id DROP NOT NULL;`);
  await pool.query(`ALTER TABLE deposits ALTER COLUMN code DROP NOT NULL;`);
  await pool.query(`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;`);
  console.log('DB ready: deposits table ok');
}

module.exports = { pool, initDb };
