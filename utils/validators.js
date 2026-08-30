function isValidPhilippineMobile(contact) {
  if (!contact) return false;
  const cleaned = contact.replace(/[\s-]/g, '');
  // Matches 09XXXXXXXXX or +639XXXXXXXXX or 639XXXXXXXXX
  const regex = /^(09|\+639|639)\d{9}$/;
  return regex.test(cleaned);
}

function isValidEmail(email) {
  if (!email) return true; // optional
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function isValidDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

module.exports = {
  isValidPhilippineMobile,
  isValidEmail,
  isValidDate
};
