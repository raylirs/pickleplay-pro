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
    type: DataTypes.STRING(255),
    allowNull: false
  },
  end_time: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  slots_json: {
    type: DataTypes.TEXT,
    allowNull: true
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
    defaultValue: 'AWAITING_PAYMENT' // AWAITING_PAYMENT, AWAITING_CONFIRMATION, CONFIRMED, CANCELLED, REJECTED, EXPIRED
  },
  payment_transaction_id: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  gcash_reference_no: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  payment_screenshot: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  payment_provider: {
    type: DataTypes.STRING(50),
    defaultValue: 'GCASH_QR'
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
