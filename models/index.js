const sequelize = require('../config/database');
const User = require('./User');
const CourtCategory = require('./CourtCategory');
const Court = require('./Court');
const Reservation = require('./Reservation');
const AuditLog = require('./AuditLog');
const SystemSetting = require('./SystemSetting');
const ChatMessage = require('./ChatMessage');
const CourtBlock = require('./CourtBlock');

// Relations
CourtCategory.hasMany(Court, { foreignKey: 'category_id', as: 'courts', onDelete: 'CASCADE' });
Court.belongsTo(CourtCategory, { foreignKey: 'category_id', as: 'category' });

Court.hasMany(Reservation, { foreignKey: 'court_id', as: 'reservations', onDelete: 'CASCADE' });
Reservation.belongsTo(Court, { foreignKey: 'court_id', as: 'court' });

Court.hasMany(CourtBlock, { foreignKey: 'court_id', as: 'blocks', onDelete: 'CASCADE' });
CourtBlock.belongsTo(Court, { foreignKey: 'court_id', as: 'court' });

User.hasMany(CourtBlock, { foreignKey: 'created_by', as: 'created_blocks' });
CourtBlock.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

User.hasMany(Reservation, { foreignKey: 'user_id', as: 'reservations' });
Reservation.belongsTo(User, { foreignKey: 'user_id', as: 'player' });

User.hasMany(ChatMessage, { foreignKey: 'user_id', as: 'chat_messages', onDelete: 'CASCADE' });
ChatMessage.belongsTo(User, { foreignKey: 'user_id', as: 'player' });

User.hasMany(AuditLog, { foreignKey: 'user_id', as: 'audit_logs' });
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

module.exports = {
  sequelize,
  User,
  CourtCategory,
  Court,
  Reservation,
  AuditLog,
  SystemSetting,
  ChatMessage,
  CourtBlock
};
