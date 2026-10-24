const { Reservation, Court, CourtBlock } = require('../models');
const { Op } = require('sequelize');
const { generateTimeSlots } = require('../utils/dateTimeUtils');

/**
 * Get all available and booked time slots for a given court and date,
 * checking both existing reservations and Admin slot/day blocks.
 */
async function getCourtAvailability(courtId, date, currentUser = null) {
  const court = await Court.findByPk(courtId);
  if (!court) {
    throw new Error('Court not found');
  }

  const now = new Date();

  // 1. Fetch active reservations that occupy slots
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

  // 2. Fetch Admin court blocks for this court or all courts on this date
  const courtBlocks = await CourtBlock.findAll({
    where: {
      date: date,
      [Op.or]: [
        { court_id: courtId },
        { court_id: null },
        { all_courts: true }
      ]
    }
  });

  const allSlots = generateTimeSlots('06:00', '24:00', 60);

  const slotsWithStatus = allSlots.map((slot) => {
    // Check if slot matches any Admin block
    const conflictingBlock = courtBlocks.find((block) => {
      if (block.is_all_day) return true;
      if (block.slots_json) {
        try {
          const bookedArr = JSON.parse(block.slots_json);
          if (Array.isArray(bookedArr)) {
            return bookedArr.includes(slot.startTime);
          }
        } catch (e) {}
      }
      return slot.startTime < block.end_time && slot.endTime > block.start_time;
    });

    // Check if slot matches any active reservation
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

    const isOwner = Boolean(
      currentUser && conflictingRes && (
        currentUser.role === 'admin' ||
        currentUser.role === 'staff' ||
        (currentUser.id && conflictingRes.user_id && Number(currentUser.id) === Number(conflictingRes.user_id)) ||
        (currentUser.phone && conflictingRes.user_contact && conflictingRes.user_contact === currentUser.phone) ||
        (currentUser.email && conflictingRes.user_email && conflictingRes.user_email.toLowerCase() === currentUser.email.toLowerCase())
      )
    );

    let isAvailable = true;
    let slotStatus = 'AVAILABLE';
    let blockReason = null;
    let blockId = null;

    if (!court.is_active) {
      isAvailable = false;
      slotStatus = 'MAINTENANCE';
    } else if (conflictingBlock) {
      isAvailable = false;
      slotStatus = 'BLOCKED';
      blockReason = conflictingBlock.reason || 'Court Maintenance / Reserved';
      blockId = conflictingBlock.id;
    } else if (conflictingRes) {
      isAvailable = false;
      slotStatus = conflictingRes.status;
    }

    return {
      startTime: slot.startTime,
      endTime: slot.endTime,
      label: slot.label,
      startLabel: slot.startLabel,
      endLabel: slot.endLabel,
      isAvailable,
      courtActive: court.is_active,
      status: slotStatus,
      blockReason,
      blockId,
      isMyBooking: isOwner,
      reservationId: isOwner ? conflictingRes.id : null,
      referenceNumber: isOwner ? conflictingRes.reference_number : null
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

/**
 * Get all dates that have full facility closures (all courts blocked all day)
 */
async function getFacilityClosedDates(startDate, endDate) {
  try {
    const whereClause = {
      is_all_day: true,
      [Op.or]: [
        { court_id: null },
        { all_courts: true }
      ]
    };

    if (startDate && endDate) {
      whereClause.date = {
        [Op.between]: [startDate, endDate]
      };
    }

    const blocks = await CourtBlock.findAll({
      where: whereClause,
      attributes: ['date', 'reason']
    });

    const closedMap = {};
    blocks.forEach(b => {
      closedMap[b.date] = b.reason;
    });

    return closedMap;
  } catch (err) {
    console.error('Error fetching closed dates:', err);
    return {};
  }
}

module.exports = {
  getCourtAvailability,
  areSlotsAvailable,
  isSlotRangeAvailable,
  getFacilityClosedDates
};
