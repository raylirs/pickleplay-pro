const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Reservation = sequelize.define('Reservation', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  reference_number: {
    type: DataTypes.STRING(50),
    unique: true,
    allowNull: false
  },
  court_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  user_name: {
    type: DataTypes.STRING(200),
    allowNull: false
  },
  user_contact: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  user_email: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  reservation_date: {
    type: DataTypes.DATEONLY,
    allowNull: false
  },
  start_time: {
    type: DataTypes.STRING(10), // HH:MM
    allowNull: false
  },
  end_time: {
    type: DataTypes.STRING(10), // HH:MM
    allowNull: false
  },
  total_hours: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  total_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false
  },
  status: {
    type: DataTypes.STRING(50),
    defaultValue: 'PENDING'
  },
  payment_transaction_id: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  payment_provider: {
    type: DataTypes.STRING(50),
    defaultValue: 'GCASH'
  },
  special_requests: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  cancellation_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'reservations',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Reservation;
