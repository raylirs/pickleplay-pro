const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CourtCategory = sequelize.define('CourtCategory', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  image_url: {
    type: DataTypes.STRING(255),
    allowNull: true,
    defaultValue: '/img/default-court.jpg'
  },
  price_per_hour: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false
  },
  total_courts: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  }
}, {
  tableName: 'court_categories',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = CourtCategory;
