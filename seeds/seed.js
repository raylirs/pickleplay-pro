const bcrypt = require('bcryptjs');
const { sequelize, User, CourtCategory, Court, SystemSetting } = require('../models');

async function seedDatabase() {
  try {
    await sequelize.sync();
    console.log('[Database] Schema synchronized.');

    // Ensure new columns exist on PostgreSQL / SQLite
    try {
      await sequelize.query('ALTER TABLE reservations ADD COLUMN IF NOT EXISTS gcash_reference_no VARCHAR(100);');
      await sequelize.query('ALTER TABLE reservations ADD COLUMN IF NOT EXISTS payment_screenshot VARCHAR(255);');
      await sequelize.query('ALTER TABLE reservations ADD COLUMN IF NOT EXISTS slots_json TEXT;');
    } catch (colErr) {
      // Ignored if already present or SQLite
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

    // Ensure 3KS Pickleball Playground exists with 4 courts
    let threeKsCat = await CourtCategory.findOne({ where: { name: '3KS Pickleball Playground' } });
    if (!threeKsCat) {
      threeKsCat = await CourtCategory.create({
        name: '3KS Pickleball Playground',
        description: 'Championship covered arena with 4 tournament-grade pickleball courts, 5M center walkway, 2 dressing rooms, player lounge, and coffee shop / mini store.',
        price_per_hour: 350.00,
        total_courts: 4,
        image_url: '/images/3ks-playground.jpg'
      });
    } else {
      threeKsCat.price_per_hour = 350.00;
      threeKsCat.total_courts = 4;
      threeKsCat.image_url = '/images/3ks-playground.jpg';
      await threeKsCat.save();
    }

    // Ensure Courts 1, 2, 3, 4 exist for 3KS Playground
    for (let i = 1; i <= 4; i++) {
      const existingCourt = await Court.findOne({
        where: {
          category_id: threeKsCat.id,
          court_number: i
        }
      });

      if (!existingCourt) {
        await Court.create({
          category_id: threeKsCat.id,
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

    // Seed Facebook Meta credentials
    await SystemSetting.upsert({
      key: 'fb_app_id',
      value: '1573381463838687',
      description: 'Facebook Meta App ID'
    });

    await SystemSetting.upsert({
      key: 'fb_app_secret',
      value: '3bf7fffdea2dc18e4327c1b1888f9452',
      description: 'Facebook Meta App Secret'
    });

    await SystemSetting.upsert({
      key: 'fb_page_id',
      value: '1224751467396635',
      description: 'Facebook Page ID (3KS Reservation)'
    });

    await SystemSetting.upsert({
      key: 'fb_page_name',
      value: '3KS Reservation',
      description: 'Facebook Page Name'
    });

    await SystemSetting.upsert({
      key: 'fb_page_token',
      value: 'EAAWWZB2sZCj98BScJhoHUJ6ZBhjKpR572BCZBJK6DT5gl1sd67nqlng5KjnEPvG4fxXtT3YlUpTTdygzsR3nRMVx9Ht37Wz4AwcZCx2aXxQNnnAZCTiQBPUhBsKAAqHwGkX5ZCoeL3h8i9dyj6yEi5pHhoZCTovdGLpuiwxztqUOthwzZBZADsJrY5fHiVFzzsH5kCLdF5kEBCbt1JjTj5Rfe28jezNxZBGHZCNzx2I5eTV6Ft0dRf7K0e5hoA2pUfiGFos26AIndJb1Cit10NeL',
      description: 'Facebook Page Access Token'
    });

    console.log('[Seed] 3KS Pickleball Playground synchronized with 4 courts, GCash QR, and Facebook Meta settings.');
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
