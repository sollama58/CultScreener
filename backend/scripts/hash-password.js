#!/usr/bin/env node
/**
 * Generate a scrypt-hashed ADMIN_PASSWORD value.
 *
 * Usage:
 *   node scripts/hash-password.js
 *
 * Copy the printed value into your environment as ADMIN_PASSWORD.
 * The format is: scrypt:<salt_hex>:<hash_hex>
 */

const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter admin password to hash: ', (password) => {
  rl.close();

  if (!password) {
    console.error('Error: password cannot be empty');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16);
  crypto.scrypt(password, salt, 64, (err, hash) => {
    if (err) {
      console.error('Error generating hash:', err.message);
      process.exit(1);
    }
    const value = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
    console.log('\nSet this as your ADMIN_PASSWORD environment variable:\n');
    console.log(value);
    console.log('');
  });
});
