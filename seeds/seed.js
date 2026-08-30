const bcrypt = require('bcryptjs');
const { sequelize, User, CourtCategory, Court } = require('../models');

async function seedDatabase() {
  try {
    await sequelize.sync();
    console.log('[Database] Schema synchronized.');

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
      console.log('[Seed] Admin user created: ' + adminUsername + ' / ' + adminPassword + '');
    } else {
      console.log('[Seed] Admin user ' + adminUsername + ' already exists.');
    }

    // 2. Seed Initial Courts if empty
    const courtCategoryCount = await CourtCategory.count();
    if (courtCategoryCount === 0) {
      const categoriesData = [
        {
          name: 'Grand Championship Court (Indoor AC)',
          description: 'Fully air-conditioned indoor championship court with 8mm tournament cushioned flooring, broadcast-grade glare-free LED lighting, and private player lounge.',
          price_per_hour: 800.00,
          total_courts: 2,
          image_url: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800&q=80'
        },
        {
          name: 'Pro Tournament Arena (Covered)',
          description: 'Weatherproof high-ceiling covered court with USAPA official dimensions, premium anti-slip coating, and high-velocity circulation fans.',
          price_per_hour: 600.00,
          total_courts: 2,
          image_url: 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?w=800&q=80'
        },
        {
          name: 'Sunset Open Arena (Outdoor)',
          description: 'Open-air scenic court with professional night floodlights, ideal for evening recreational play, doubles match practice, and friendly leagues.',
          price_per_hour: 450.00,
          total_courts: 2,
          image_url: 'https://images.unsplash.com/photo-1599586120429-48281b6f0ece?w=800&q=80'
        }
      ];

      for (const catData of categoriesData) {
        const cat = await CourtCategory.create(catData);
        for (let i = 1; i <= catData.total_courts; i++) {
          await Court.create({
            category_id: cat.id,
            court_number: i,
            display_name: cat.name + ' - ' + i,
            is_active: true
          });
        }
      }
      console.log('[Seed] Created default court categories and sub-courts.');
    } else {
      console.log('[Seed] Court categories already present.');
    }

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
