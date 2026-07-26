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
      customer_id TEXT NOT NULL,
      code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deposited_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_deposits_customer_status
    ON deposits (customer_id, status);
  `);
  // Migration: older deployments created this table before removed_at existed.
  await pool.query(`
    ALTER TABLE deposits ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
  `);
  console.log('DB ready: deposits table ok');
}

module.exports = { pool, initDb };
