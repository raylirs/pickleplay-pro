const bcrypt = require('bcryptjs');
const { sequelize, User, CourtCategory, Court, SystemSetting } = require('../models');

async function seedDatabase() {
  try {
    await sequelize.sync();
    console.log('[Database] Schema synchronized.');

    // Ensure new columns exist on PostgreSQL / SQLite
    const newColumns = [
      { name: 'gcash_reference_no', type: 'VARCHAR(100)' },
      { name: 'payment_screenshot', type: 'VARCHAR(255)' },
      { name: 'slots_json', type: 'TEXT' },
      { name: 'fb_psid', type: 'VARCHAR(100)' },
      { name: 'binding_code', type: 'VARCHAR(20)' },
      { name: 'user_id', type: 'INTEGER' }
    ];

    for (const col of newColumns) {
      try {
        await sequelize.query(`ALTER TABLE reservations ADD COLUMN ${col.name} ${col.type};`);
      } catch (colErr) {
        // Ignored if column already exists
      }
    }

    const isPostgres = sequelize.getDialect() === 'postgres';
    const userColumns = [
      { name: 'full_name', type: 'VARCHAR(200)' },
      { name: 'email', type: 'VARCHAR(200)' },
      { name: 'phone', type: 'VARCHAR(50)' },
      { name: 'fb_psid', type: 'VARCHAR(100)' },
      { name: 'binding_code', type: 'VARCHAR(20)' },
      { name: 'email_verified', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'otp_code', type: 'VARCHAR(20)' },
      { name: 'otp_expires_at', type: isPostgres ? 'TIMESTAMP WITH TIME ZONE' : 'TIMESTAMP' },
      { name: 'otp_purpose', type: 'VARCHAR(50)' }
    ];

    for (const col of userColumns) {
      try {
        await sequelize.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type};`);
      } catch (colErr) {
        // Ignored if column already exists
      }
    }

    if (isPostgres) {
      try {
        await sequelize.query(`ALTER TABLE users ALTER COLUMN otp_expires_at TYPE TIMESTAMP WITH TIME ZONE USING otp_expires_at AT TIME ZONE 'UTC';`);
      } catch (colErr) {
        // Ignored if already timestamptz
      }
    }

    // 1. Seed Admin User
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    const existingAdmin = await User.findOne({ where: { username: adminUsername } });
    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await User.create({
        username: adminUsername,
        password_hash: passwordHash,
        role: 'admin'
      });
      console.log('[Seed] Admin user created: ' + adminUsername);
    } else {
      console.log('[Seed] Admin user ' + adminUsername + ' already exists.');
    }

    // 2. Clean up any dummy/placeholder categories and ensure ONLY 3KS Playground exists
    const dummyCategories = await CourtCategory.findAll({
      where: {
        name: ['Grand Championship Court (Indoor AC)', 'Pro Tournament Arena (Covered)', 'Sunset Open Arena (Outdoor)']
      }
    });

    for (const dummy of dummyCategories) {
      await Court.destroy({ where: { category_id: dummy.id } });
      await dummy.destroy();
      console.log(`[Seed] Removed dummy category: ${dummy.name}`);
    }

    // 2. Direct SQL and ORM update for court_categories to ensure Supabase matches The Playground
    try {
      await sequelize.query(`
        UPDATE court_categories
        SET name = 'The Playground Pickleball',
            image_url = '/images/the-playground-logo.jpg',
            description = 'Championship covered arena with 4 tournament-grade pickleball courts, 5M center walkway, 2 dressing rooms, player lounge, and coffee shop / mini store.'
        WHERE id = 4 OR name = '3KS Pickleball Playground';
      `);
      console.log('[Seed] court_categories table updated to The Playground Pickleball.');
    } catch (sqlErr) {
      console.log('[Seed] Direct SQL update note:', sqlErr.message);
    }

    // Ensure The Playground Pickleball exists in DB
    let playgroundCat = await CourtCategory.findOne({
      where: {
        name: ['The Playground Pickleball', '3KS Pickleball Playground']
      }
    });

    if (!playgroundCat) {
      playgroundCat = await CourtCategory.create({
        name: 'The Playground Pickleball',
        description: 'Championship covered arena with 4 tournament-grade pickleball courts, 5M center walkway, 2 dressing rooms, player lounge, and coffee shop / mini store.',
        price_per_hour: 350.00,
        total_courts: 4,
        image_url: '/images/the-playground-logo.jpg'
      });
      console.log('[Seed] Created category: The Playground Pickleball');
    } else {
      playgroundCat.name = 'The Playground Pickleball';
      playgroundCat.description = 'Championship covered arena with 4 tournament-grade pickleball courts, 5M center walkway, 2 dressing rooms, player lounge, and coffee shop / mini store.';
      playgroundCat.price_per_hour = 350.00;
      playgroundCat.total_courts = 4;
      playgroundCat.image_url = '/images/the-playground-logo.jpg';
      await playgroundCat.save();
      console.log('[Seed] Updated category: The Playground Pickleball');
    }

    // Ensure Courts 1, 2, 3, 4 exist for The Playground
    for (let i = 1; i <= 4; i++) {
      const existingCourt = await Court.findOne({
        where: {
          category_id: playgroundCat.id,
          court_number: i
        }
      });

      if (!existingCourt) {
        await Court.create({
          category_id: playgroundCat.id,
          court_number: i,
          display_name: 'Court ' + i,
          is_active: true
        });
      } else {
        existingCourt.display_name = 'Court ' + i;
        await existingCourt.save();
      }
    }

    // Seed official GCash SystemSettings
    await SystemSetting.upsert({
      key: 'GCASH_QR_IMAGE',
      value: '/images/gcash-qr.jpg',
      description: 'Official GCash InstaPay QR Code'
    });

    await SystemSetting.upsert({
      key: 'GCASH_ACCOUNT_NAME',
      value: 'KA**O P.',
      description: 'Merchant GCash Account Name'
    });

    await SystemSetting.upsert({
      key: 'GCASH_ACCOUNT_NUMBER',
      value: '0977-013-5041',
      description: 'Merchant GCash Mobile Number'
    });

    // Seed Facebook Meta credentials (preserve any custom values saved in Admin Settings)
    const fbDefaults = [
      {
        key: 'fb_app_id',
        value: '1573381463838687',
        description: 'Facebook Meta App ID'
      },
      {
        key: 'fb_app_secret',
        value: '3bf7fffdea2dc18e4327c1b1888f9452',
        description: 'Facebook Meta App Secret'
      },
      {
        key: 'fb_page_id',
        value: '1224751467396635',
        description: 'Facebook Page ID (The Playground Pickleball)'
      },
      {
        key: 'fb_page_name',
        value: 'The Playground Pickleball',
        description: 'Facebook Page Name'
      },
      {
        key: 'fb_page_token',
        value: 'EAAWWZB2sZCj98BStXkhzebYUyqbVZBRMvylumn14cXdkhCqAGZButIek2SmOYAsLO3v8PI6p5g54L7hXyq9v2A61SezkZAbK5LwL8MenFvCm8jwGygRGWqIqEPmB1Bv2IX9KBTAkQr2HnFDRZBPFws98Pd52TDArvMWCaOQfjHClhZCA3EpiARhTujWoNyYllAs00SV',
        description: 'Permanent Never-Expiring Facebook Page Access Token'
      },
      {
        key: 'fb_admin_psid',
        value: '27030144379994794, 38090624017219189',
        description: 'Admin Facebook Messenger Profile PSIDs (Ryan & Karlo)'
      }
    ];

    for (const item of fbDefaults) {
      const existing = await SystemSetting.findOne({ where: { key: item.key } });
      if (!existing || !existing.value || !String(existing.value).trim()) {
        await SystemSetting.upsert(item);
      }
    }

    console.log('[Seed] The Playground Pickleball synchronized with 4 courts, GCash QR, and Facebook Meta settings.');
    console.log('[Seed] Database initialization completed successfully.');
  } catch (err) {
    console.error('[Seed Error]:', err);
    throw err;
  }
}

if (require.main === module) {
  seedDatabase().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = seedDatabase;
