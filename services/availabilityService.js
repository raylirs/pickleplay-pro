const { Reservation, Court } = require('../models');
const { Op } = require('sequelize');
const { generateTimeSlots } = require('../utils/dateTimeUtils');

/**
 * Get all available and booked time slots for a given court and date
 */
async function getCourtAvailability(courtId, date) {
  const court = await Court.findByPk(courtId);
  if (!court) {
    throw new Error('Court not found');
  }

  // Active reservations that block slots:
  // CONFIRMED, AWAITING_CONFIRMATION, or AWAITING_PAYMENT / PENDING that haven't expired
  const now = new Date();
  const existingReservations = await Reservation.findAll({
    where: {
      court_id: courtId,
      reservation_date: date,
      [Op.or]: [
        { status: 'CONFIRMED' },
        { status: 'AWAITING_CONFIRMATION' },
        {
          status: { [Op.in]: ['AWAITING_PAYMENT', 'PENDING'] },
          expires_at: { [Op.gt]: now }
        }
      ]
    }
  });

  const allSlots = generateTimeSlots('08:00', '24:00', 60);

  const slotsWithStatus = allSlots.map((slot) => {
    // Check if slot matches any active reservation (either via slots_json or continuous start_time/end_time)
    const conflictingRes = existingReservations.find((res) => {
      if (res.slots_json) {
        try {
          const bookedArr = JSON.parse(res.slots_json);
          if (Array.isArray(bookedArr) && bookedArr.includes(slot.startTime)) {
            return true;
          }
        } catch (e) {}
      }
      return slot.startTime < res.end_time && slot.endTime > res.start_time;
    });

    return {
      startTime: slot.startTime,
      endTime: slot.endTime,
      label: slot.label,
      startLabel: slot.startLabel,
      endLabel: slot.endLabel,
      isAvailable: !conflictingRes && court.is_active,
      courtActive: court.is_active,
      status: !court.is_active ? 'MAINTENANCE' : (conflictingRes ? conflictingRes.status : 'AVAILABLE'),
      reservationId: conflictingRes ? conflictingRes.id : null,
      referenceNumber: conflictingRes ? conflictingRes.reference_number : null
    };
  });

  return {
    court,
    date,
    slots: slotsWithStatus
  };
}

/**
 * Validate whether a list of requested slot start times is available
 */
async function areSlotsAvailable(courtId, date, requestedSlots = [], excludeReservationId = null) {
  const court = await Court.findByPk(courtId);
  if (!court || !court.is_active || !requestedSlots || requestedSlots.length === 0) {
    return false;
  }

  const availability = await getCourtAvailability(courtId, date);
  const availableSlotsMap = new Set(
    availability.slots.filter(s => s.isAvailable).map(s => s.startTime)
  );

  return requestedSlots.every(slotTime => availableSlotsMap.has(slotTime));
}

/**
 * Validate whether a requested time range is fully available (backwards-compatibility)
 */
async function isSlotRangeAvailable(courtId, date, startTime, endTime, excludeReservationId = null) {
  const court = await Court.findByPk(courtId);
  if (!court || !court.is_active) {
    return false;
  }

  const availability = await getCourtAvailability(courtId, date);
  const rangeSlots = availability.slots.filter(s => s.startTime >= startTime && s.startTime < endTime);
  if (rangeSlots.length === 0) return false;

  return rangeSlots.every(s => s.isAvailable);
}

module.exports = {
  getCourtAvailability,
  areSlotsAvailable,
  isSlotRangeAvailable
};
