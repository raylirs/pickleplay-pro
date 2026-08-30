const crypto = require('crypto');

function generateReferenceNumber(prefix) {
  if (!prefix) prefix = 'PKL';
  const year = new Date().getFullYear();
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
  const timestampPart = Date.now().toString().slice(-4);
  return prefix + '-' + year + '-' + randomHex + timestampPart;
}

module.exports = { generateReferenceNumber };
