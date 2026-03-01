#!/usr/bin/env node
/**
 * Seed script – creates the platform Superadmin in MongoDB.
 * Run once:  npm run seed
 * If the superadmin email already exists the script exits without changes.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

const {
  MONGO_URI,
  SUPERADMIN_EMAIL,
  SUPERADMIN_PASSWORD,
  SUPERADMIN_NAME,
} = process.env;

if (!MONGO_URI || !SUPERADMIN_EMAIL || !SUPERADMIN_PASSWORD) {
  console.error('❌  Missing env vars: MONGO_URI, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅  Connected to MongoDB');

    const existing = await User.findOne({ email: SUPERADMIN_EMAIL.toLowerCase() });

    if (existing) {
      console.log(`ℹ️   Superadmin already exists: ${existing.email}  (role: ${existing.role})`);
      await mongoose.disconnect();
      process.exit(0);
    }

    const superadmin = await User.create({
      email: SUPERADMIN_EMAIL,
      username: 'superadmin',
      password: SUPERADMIN_PASSWORD,
      full_name: SUPERADMIN_NAME || 'Platform Superadmin',
      role: 'superadmin',
      is_active: true,
      is_verified: true,
    });

    console.log('🎉  Superadmin created successfully!');
    console.log(`    email   : ${superadmin.email}`);
    console.log(`    password: ${SUPERADMIN_PASSWORD}`);
    console.log('    ⚠️  Change the password in production!');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌  Seed error:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
})();
