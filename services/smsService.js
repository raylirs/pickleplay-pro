const { formatTime12 } = require('../utils/dateTimeUtils');

async function sendReservationSMS(reservation, court) {
  if (!reservation.user_contact) {
    return { success: false, reason: 'No contact number' };
  }

  const courtName = court ? court.display_name : 'Court';
  const message = `PicklePlay Pro: Your booking for ${courtName} on ${reservation.reservation_date} (${formatTime12(reservation.start_time)}-${formatTime12(reservation.end_time)}) is CONFIRMED! Ref: ${reservation.reference_number}. See you on the court!`;

  console.log(`[SMS Service] Dispatching SMS to ${reservation.user_contact}: "${message}"`);
  return { success: true, message, recipient: reservation.user_contact };
}

module.exports = { sendReservationSMS };
