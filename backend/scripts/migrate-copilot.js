// backend/scripts/migrate-copilot.js — Sprint 6
// Additive only. Proposals the Copilot prepared (single-use, expiring) and
// the audit trail of every ask/confirm.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_proposals (
        id UUID PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        tool VARCHAR(60) NOT NULL,
        args JSONB NOT NULL,
        preview_text TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        confirmed_at TIMESTAMP,
        result JSONB,
        last_error TEXT
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_proposals_user ON ai_proposals(user_id, created_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_actions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        request_text TEXT,
        context JSONB,
        interpretation JSONB,
        tools_read TEXT[],
        proposal_id UUID,
        confirmed_at TIMESTAMP,
        result_text TEXT,
        error TEXT,
        ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_actions_created ON ai_actions(created_at DESC)`);
    await client.query(`ALTER TABLE ai_reads ADD COLUMN IF NOT EXISTS kind VARCHAR(30)`);
    console.log('✅ copilot migration complete (ai_proposals + ai_actions)');
  } catch (err) {
    console.error('❌ copilot migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
