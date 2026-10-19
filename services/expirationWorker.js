const { Reservation, Court } = require('../models');
const { Op } = require('sequelize');
const { getIO } = require('../config/socket');
const { getCourtAvailability } = require('./availabilityService');
const { logAudit } = require('../utils/helpers');

let workerInterval = null;

function startExpirationWorker() {
  if (workerInterval) return;

  workerInterval = setInterval(async () => {
    try {
      const now = new Date();
      const expiredReservations = await Reservation.findAll({
        where: {
          status: { [Op.in]: ['AWAITING_PAYMENT', 'PENDING'] },
          expires_at: { [Op.lt]: now }
        },
        include: [{ model: Court, as: 'court' }]
      });

      if (!expiredReservations || expiredReservations.length === 0) return;

      const notifiedMasterRefs = new Map();

      for (const res of expiredReservations) {
        res.status = 'CANCELLED';
        res.cancellation_reason = 'Automatically cancelled: 15-minute unpaid GCash hold timed out';
        await res.save();

        const masterRef = (res.reference_number || '').split('-')[0];
        if (!notifiedMasterRefs.has(masterRef)) {
          notifiedMasterRefs.set(masterRef, res);
        }

        console.log('[Expiration Worker] Unpaid hold ' + res.reference_number + ' timed out & cancelled. Released court ' + res.court_id + '.');
        await logAudit('RESERVATION_HOLD_CANCELLED_TIMEOUT', {
          referenceNumber: res.reference_number,
          courtId: res.court_id,
          date: res.reservation_date,
          startTime: res.start_time,
          endTime: res.end_time
        });

        try {
          const io = getIO();
          const availabilityData = await getCourtAvailability(res.court_id, res.reservation_date);
          io.emit('court_availability_updated', {
            courtId: res.court_id,
            date: res.reservation_date,
            slots: availabilityData.slots
          });
        } catch (e) {
          // ignore socket warning
        }
      }

      // Send 1 unified notification per expired booking order (Socket + In-App Chat + Messenger)
      for (const [masterRef, primaryRes] of notifiedMasterRefs.entries()) {
        try {
          const io = getIO();
          io.emit('reservation_hold_expired', {
            reference: masterRef,
            userId: primaryRes.user_id || null,
            userPhone: primaryRes.user_contact || null,
            date: primaryRes.reservation_date,
            courtName: primaryRes.court ? primaryRes.court.display_name : `Court ${primaryRes.court_id}`,
            message: `⏰ Your unpaid court hold (#${masterRef}) has timed out after 15 minutes and was automatically cancelled.`
          });
        } catch (e) {}

        try {
          const { postBookingSystemMessage } = require('./chatService');
          await postBookingSystemMessage(primaryRes, 'HOLD_EXPIRED_CANCELLED');
        } catch (e) {}

        try {
          const { notifyPlayerHoldExpired } = require('./facebookService');
          await notifyPlayerHoldExpired(primaryRes);
        } catch (e) {}
      }
    } catch (err) {
      console.error('[Expiration Worker Error]:', err.message);
    }
  }, 10000);

  console.log('[Worker] Unpaid hold auto-cancel & notification worker active (10s interval).');
}

function stopExpirationWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

module.exports = { startExpirationWorker, stopExpirationWorker };
