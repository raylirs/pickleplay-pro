const { AuditLog } = require('../models');

async function logAudit(action, details, userId = null) {
  try {
    await AuditLog.create({
      action,
      details: typeof details === 'object' ? JSON.stringify(details) : details,
      user_id: userId
    });
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

module.exports = { logAudit };
