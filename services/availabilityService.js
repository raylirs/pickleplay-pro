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
    // Check if slot overlaps with any active reservation
    // A slot [slot.startTime, slot.endTime) overlaps with [res.start_time, res.end_time)
    // if slot.startTime < res.end_time && slot.endTime > res.start_time
    const conflictingRes = existingReservations.find((res) => {
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
 * Validate whether a requested time range is fully available
 */
async function isSlotRangeAvailable(courtId, date, startTime, endTime, excludeReservationId = null) {
  const court = await Court.findByPk(courtId);
  if (!court || !court.is_active) {
    return false;
  }

  const now = new Date();
  const whereClause = {
    court_id: courtId,
    reservation_date: date,
    [Op.or]: [
      { status: 'CONFIRMED' },
      { status: 'AWAITING_CONFIRMATION' },
      {
        status: { [Op.in]: ['AWAITING_PAYMENT', 'PENDING'] },
        expires_at: { [Op.gt]: now }
      }
    ],
    // Overlap condition: startTime < res.end_time AND endTime > res.start_time
    [Op.and]: [
      { start_time: { [Op.lt]: endTime } },
      { end_time: { [Op.gt]: startTime } }
    ]
  };

  if (excludeReservationId) {
    whereClause.id = { [Op.ne]: excludeReservationId };
  }

  const conflicting = await Reservation.findOne({ where: whereClause });
  return !conflicting;
}

module.exports = {
  getCourtAvailability,
  isSlotRangeAvailable
};
