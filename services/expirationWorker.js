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

      for (const res of expiredReservations) {
        res.status = 'EXPIRED';
        await res.save();

        console.log('[Expiration Worker] Reservation ' + res.reference_number + ' expired. Released court ' + res.court_id + '.');
        await logAudit('RESERVATION_EXPIRED', {
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
    } catch (err) {
      console.error('[Expiration Worker Error]:', err.message);
    }
  }, 30000);

  console.log('[Worker] Reservation expiration worker active (30s interval).');
}

function stopExpirationWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

module.exports = { startExpirationWorker, stopExpirationWorker };
