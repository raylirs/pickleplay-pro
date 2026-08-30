const sequelize = require('../config/database');
const User = require('./User');
const CourtCategory = require('./CourtCategory');
const Court = require('./Court');
const Reservation = require('./Reservation');
const AuditLog = require('./AuditLog');

// Relations
CourtCategory.hasMany(Court, { foreignKey: 'category_id', as: 'courts', onDelete: 'CASCADE' });
Court.belongsTo(CourtCategory, { foreignKey: 'category_id', as: 'category' });

Court.hasMany(Reservation, { foreignKey: 'court_id', as: 'reservations', onDelete: 'CASCADE' });
Reservation.belongsTo(Court, { foreignKey: 'court_id', as: 'court' });

User.hasMany(AuditLog, { foreignKey: 'user_id', as: 'audit_logs' });
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

module.exports = {
  sequelize,
  User,
  CourtCategory,
  Court,
  Reservation,
  AuditLog
};
