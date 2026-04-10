// scripts/migrate.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running migrations...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ users table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(20) UNIQUE NOT NULL,
        floor INTEGER DEFAULT 1,
        total_beds INTEGER NOT NULL DEFAULT 1,
        room_type VARCHAR(50) DEFAULT 'shared',
        monthly_rent DECIMAL(10,2) DEFAULT 0,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ rooms table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(15),
        email VARCHAR(100),
        emergency_contact VARCHAR(15),
        id_proof_type VARCHAR(50),
        id_proof_number VARCHAR(50),
        room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
        bed_number INTEGER,
        join_date DATE NOT NULL,
        leave_date DATE,
        monthly_rent DECIMAL(10,2) DEFAULT 0,
        deposit_amount DECIMAL(10,2) DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ guests table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS collections (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        guest_name VARCHAR(100),
        amount DECIMAL(10,2) NOT NULL,
        collection_date DATE NOT NULL DEFAULT CURRENT_DATE,
        collection_month VARCHAR(20),
        collection_type VARCHAR(50) DEFAULT 'rent',
        payment_mode VARCHAR(50) DEFAULT 'cash',
        description TEXT,
        receipt_number VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ collections table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        amount DECIMAL(10,2) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'other',
        description TEXT,
        purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
        paid_to VARCHAR(100),
        payment_mode VARCHAR(50) DEFAULT 'cash',
        receipt_number VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ purchases table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_menu (
        id SERIAL PRIMARY KEY,
        day_of_week VARCHAR(10) NOT NULL,
        meal_type VARCHAR(20) NOT NULL,
        items TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(day_of_week, meal_type)
      );
    `);
    console.log('✅ daily_menu table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        priority VARCHAR(20) DEFAULT 'normal',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ announcements table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id SERIAL PRIMARY KEY,
        guest_name VARCHAR(100) NOT NULL,
        guest_phone VARCHAR(15),
        room_number VARCHAR(20),
        subject VARCHAR(200),
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        reply TEXT,
        replied_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ inbox_messages table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        details TEXT,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ activity_log table ready');

    console.log('\n🎉 All migrations completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
