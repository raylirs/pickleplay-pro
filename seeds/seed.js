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
      console.log('[Seed] Admin user created: ' + adminUsername + ' / ' + adminPassword);
    } else {
      console.log('[Seed] Admin user ' + adminUsername + ' already exists.');
    }

    // 2. Seed 3KS Pickleball Playground 4 Courts if empty or update
    const existingCategory = await CourtCategory.findOne({ where: { name: '3KS Pickleball Playground' } });
    if (!existingCategory) {
      // Clear placeholder categories if needed or create 3KS
      const cat = await CourtCategory.create({
        name: '3KS Pickleball Playground',
        description: 'Championship covered arena with 4 tournament-grade pickleball courts, 5M center walkway, 2 dressing rooms, player lounge, and coffee shop / mini store.',
        price_per_hour: 350.00,
        total_courts: 4,
        image_url: '/images/3ks-playground.jpg'
      });

      for (let i = 1; i <= 4; i++) {
        await Court.create({
          category_id: cat.id,
          court_number: i,
          display_name: 'Court ' + i,
          is_active: true
        });
      }
      console.log('[Seed] Created 3KS Pickleball Playground with Courts 1, 2, 3, and 4 @ ₱350/hr.');
    } else {
      console.log('[Seed] 3KS Pickleball Playground already exists.');
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
