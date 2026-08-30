const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Court = sequelize.define('Court', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  category_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  court_number: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  display_name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'courts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = Court;
