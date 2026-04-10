// scripts/seed.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding database...');

    const password = 'SiriMane@2024';
    const hash = await bcrypt.hash(password, 12);

    await client.query(`
      INSERT INTO users (username, password_hash, role)
      VALUES ('admin', $1, 'admin')
      ON CONFLICT (username) DO NOTHING
    `, [hash]);

    console.log('✅ Admin user created');
    console.log('   Username: admin');
    console.log('   Password: SiriMane@2024');
    console.log('   ⚠️  Change this password immediately after first login!');

    console.log('\n🎉 Seed completed!');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
