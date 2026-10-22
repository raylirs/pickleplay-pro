const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CourtBlock = sequelize.define('CourtBlock', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  court_id: {
    type: DataTypes.INTEGER,
    allowNull: true // null means applies to all courts
  },
  date: {
    type: DataTypes.STRING(20), // YYYY-MM-DD
    allowNull: false
  },
  start_time: {
    type: DataTypes.STRING(10), // e.g. '08:00'
    allowNull: false,
    defaultValue: '08:00'
  },
  end_time: {
    type: DataTypes.STRING(10), // e.g. '24:00'
    allowNull: false,
    defaultValue: '24:00'
  },
  slots_json: {
    type: DataTypes.TEXT,
    allowNull: true // JSON string of slot start times e.g. '["08:00","09:00"]'
  },
  is_all_day: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  all_courts: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  reason: {
    type: DataTypes.STRING(255),
    allowNull: false,
    defaultValue: 'Maintenance / Reserved'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: true
  }
}, {
  tableName: 'court_blocks',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = CourtBlock;
