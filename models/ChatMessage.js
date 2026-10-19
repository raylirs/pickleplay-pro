const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChatMessage = sequelize.define('ChatMessage', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  sender_role: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'system' // 'player', 'admin', 'system'
  },
  sender_name: {
    type: DataTypes.STRING(150),
    allowNull: true
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  booking_ref: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  booking_status: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  is_read_by_player: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  is_read_by_admin: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'chat_messages',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = ChatMessage;
