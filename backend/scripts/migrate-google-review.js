// backend/scripts/migrate-google-review.js — Sprint 24
// Additive only. The resident app asks each resident ONCE, after her first
// 30 days, for a Google review. Two columns remember that she was asked and
// what she did, so the card never comes back on any phone. The review link
// lives in app_settings so it can be changed without a deploy.
// Safe to re-run.
//
// Railway web console:  node backend/scripts/migrate-google-review.js
const pool = require('../db');

const REVIEW_URL = 'https://g.page/r/CeV_6hO1dexlEBM/review';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS review_prompt_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS review_prompt_action VARCHAR(20)`);
    console.log('✅ guests.review_prompt_at / review_prompt_action ready');
    await client.query(`INSERT INTO app_settings(key, value) VALUES('google_review_url', $1) ON CONFLICT (key) DO NOTHING`, [REVIEW_URL]);
    console.log('✅ app_settings.google_review_url present (existing value kept)');
  } finally { client.release(); }
}

migrate().then(() => pool.end()).catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
