#!/usr/bin/env node

/**
 * CultScreener Database Migration Script
 *
 * This script initializes or updates the database schema.
 * Run this after deploying to Render or when setting up locally.
 *
 * Usage:
 *   node db/migrate.js              - Run migrations
 *   node db/migrate.js --seed       - Run migrations and seed test data
 *   node db/migrate.js --status     - Check database connection status
 *   node db/migrate.js --reset      - Drop and recreate all tables (DESTRUCTIVE!)
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Parse command line arguments
const args = process.argv.slice(2);
const shouldSeed = args.includes('--seed');
const checkStatus = args.includes('--status');
const shouldReset = args.includes('--reset');

// ANSI color codes for output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Check database connection
async function checkConnection() {
  try {
    const result = await pool.query('SELECT NOW() as time, version() as version');
    log('Database connection successful!', 'green');
    log(`  Server time: ${result.rows[0].time}`, 'blue');
    log(`  PostgreSQL: ${result.rows[0].version.split(',')[0]}`, 'blue');
    return true;
  } catch (error) {
    log(`Database connection failed: ${error.message}`, 'red');
    return false;
  }
}

// Run the init.sql script
async function runMigrations() {
  const client = await pool.connect();

  try {
    log('\nRunning database migrations...', 'yellow');

    // Read and execute the init.sql file
    const initSqlPath = path.join(__dirname, 'init.sql');
    const initSql = fs.readFileSync(initSqlPath, 'utf8');

    await client.query(initSql);

    log('Migrations completed successfully!', 'green');

    // Show table counts
    const tables = ['tokens', 'submissions', 'votes', 'vote_tallies', 'sentiment_votes', 'sentiment_tallies'];
    log('\nCurrent table status:', 'blue');

    for (const table of tables) {
      try {
        const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
        log(`  ${table}: ${result.rows[0].count} rows`, 'reset');
      } catch {
        log(`  ${table}: not created yet`, 'yellow');
      }
    }

    return true;
  } catch (error) {
    log(`Migration failed: ${error.message}`, 'red');
    console.error(error);
    return false;
  } finally {
    client.release();
  }
}

// Reset database (drop all tables)
async function resetDatabase() {
  const client = await pool.connect();

  try {
    log('\nResetting database (dropping all tables)...', 'red');

    await client.query(`
      DROP TABLE IF EXISTS curated_tokens CASCADE;
      DROP TABLE IF EXISTS sentiment_votes CASCADE;
      DROP TABLE IF EXISTS sentiment_tallies CASCADE;
      DROP TABLE IF EXISTS watchlist CASCADE;
      DROP TABLE IF EXISTS token_views CASCADE;
      DROP TABLE IF EXISTS announcements CASCADE;
      DROP TABLE IF EXISTS device_sessions CASCADE;
      DROP TABLE IF EXISTS admin_sessions CASCADE;
      DROP TABLE IF EXISTS api_keys CASCADE;
      DROP TABLE IF EXISTS watchlist CASCADE;
      DROP TABLE IF EXISTS submissions CASCADE;
      DROP TABLE IF EXISTS tokens CASCADE;
      DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;
      DROP FUNCTION IF EXISTS recalculate_vote_tally CASCADE;
      DROP FUNCTION IF EXISTS auto_moderate_submission CASCADE;
    `);

    log('All tables dropped successfully!', 'green');
    return true;
  } catch (error) {
    log(`Reset failed: ${error.message}`, 'red');
    return false;
  } finally {
    client.release();
  }
}

// Seed test data
async function seedTestData() {
  const client = await pool.connect();

  try {
    log('\nSeeding test data...', 'yellow');

    // Insert some well-known Solana tokens
    await client.query(`
      INSERT INTO tokens (mint_address, name, symbol, decimals, logo_uri)
      VALUES
        ('So11111111111111111111111111111111111111112', 'Wrapped SOL', 'SOL', 9,
         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'),
        ('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USD Coin', 'USDC', 6,
         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'),
        ('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT', 'USDT', 6,
         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png'),
        ('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'Marinade staked SOL', 'mSOL', 9,
         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png'),
        ('7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', 'Lido Staked SOL', 'stSOL', 9,
         'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj/logo.png')
      ON CONFLICT (mint_address) DO NOTHING
    `);

    log('Test data seeded successfully!', 'green');

    // Count inserted rows
    const result = await client.query('SELECT COUNT(*) as count FROM tokens');
    log(`  Tokens in database: ${result.rows[0].count}`, 'blue');

    return true;
  } catch (error) {
    log(`Seeding failed: ${error.message}`, 'red');
    return false;
  } finally {
    client.release();
  }
}

// Main function
async function main() {
  log('\n========================================', 'blue');
  log('  CultScreener Database Migration', 'blue');
  log('========================================\n', 'blue');

  if (!process.env.DATABASE_URL) {
    log('ERROR: DATABASE_URL environment variable is not set!', 'red');
    log('Please set it in your .env file or environment.', 'yellow');
    process.exit(1);
  }

  // Check connection first
  const connected = await checkConnection();
  if (!connected) {
    process.exit(1);
  }

  // Status check only
  if (checkStatus) {
    await pool.end();
    process.exit(0);
  }

  // Reset if requested
  if (shouldReset) {
    const resetSuccess = await resetDatabase();
    if (!resetSuccess) {
      await pool.end();
      process.exit(1);
    }
  }

  // Run migrations
  const migrateSuccess = await runMigrations();
  if (!migrateSuccess) {
    await pool.end();
    process.exit(1);
  }

  // Seed if requested
  if (shouldSeed) {
    await seedTestData();
  }

  log('\nDone!', 'green');
  await pool.end();
  process.exit(0);
}

// Run
main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
