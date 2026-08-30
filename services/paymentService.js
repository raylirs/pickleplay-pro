const crypto = require('crypto');
const { Reservation, Court, CourtCategory } = require('../models');
const { getIO } = require('../config/socket');
const { getCourtAvailability } = require('./availabilityService');
const { sendReservationConfirmation } = require('./emailService');
const { sendReservationSMS } = require('./smsService');
const { logAudit } = require('../utils/helpers');

class PaymentService {
  constructor() {
    this.apiKey = process.env.GCASH_API_KEY || 'mock_gcash_key';
    this.baseUrl = process.env.GCASH_BASE_URL || '/mock-gcash';
    this.webhookSecret = process.env.GCASH_WEBHOOK_SECRET || 'mock_secret';
  }

  async createPaymentIntent(reservation) {
    // Use relative path so it seamlessly works on both localhost and cloud (Render/Supabase)
    const paymentUrl = `/payment/gcash-checkout?ref=${reservation.reference_number}`;
    const transactionId = `GCASH-TXN-${Date.now()}-${reservation.id}`;

    return {
      paymentUrl,
      transactionId,
      referenceNumber: reservation.reference_number,
      amount: reservation.total_amount
    };
  }

  verifyWebhookSignature(signatureHeader, payload) {
    if (!signatureHeader || !this.webhookSecret) return true;
    try {
      const computed = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
        .digest('hex');
      return signatureHeader === computed || signatureHeader.includes(computed);
    } catch (e) {
      return false;
    }
  }

  async processPaymentSuccess(referenceNumber, transactionId = null, provider = 'GCASH') {
    const ref = referenceNumber ? referenceNumber.trim() : '';
    const reservation = await Reservation.findOne({
      where: { reference_number: ref },
      include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }]
    });

    if (!reservation) {
      throw new Error(`Reservation ${referenceNumber} not found`);
    }

    if (reservation.status === 'CONFIRMED') {
      return { reservation, alreadyConfirmed: true };
    }

    reservation.status = 'CONFIRMED';
    reservation.payment_transaction_id = transactionId || `GCASH-TXN-${Date.now()}`;
    reservation.payment_provider = provider;
    await reservation.save();

    await logAudit('PAYMENT_CONFIRMED', {
      referenceNumber: reservation.reference_number,
      transactionId: reservation.payment_transaction_id,
      amount: reservation.total_amount,
      provider
    });

    await sendReservationConfirmation(reservation, reservation.court);
    await sendReservationSMS(reservation, reservation.court);

    try {
      const io = getIO();
      const availabilityData = await getCourtAvailability(reservation.court_id, reservation.reservation_date);
      
      io.emit('court_availability_updated', {
        courtId: reservation.court_id,
        date: reservation.reservation_date,
        slots: availabilityData.slots
      });

      io.emit('payment_confirmed', {
        reference: reservation.reference_number,
        courtId: reservation.court_id,
        courtName: reservation.court ? reservation.court.display_name : '',
        date: reservation.reservation_date,
        startTime: reservation.start_time,
        endTime: reservation.end_time,
        amount: reservation.total_amount
      });
    } catch (socketErr) {
      console.warn('Socket broadcast warning:', socketErr.message);
    }

    return { reservation, alreadyConfirmed: false };
  }
}

module.exports = new PaymentService();
