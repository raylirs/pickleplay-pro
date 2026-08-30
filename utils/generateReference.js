const crypto = require('crypto');

function generateReferenceNumber(prefix) {
  if (!prefix) prefix = '3KS';
  const year = new Date().getFullYear();
  // Generate clean alphanumeric 4-byte uppercase hex (8 chars) with NO hyphens
  const randomAlnum = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}${year}${randomAlnum}`; // e.g. 3KS2026A1F92B
}

module.exports = { generateReferenceNumber };
