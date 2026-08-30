const { Reservation, Court, CourtCategory } = require('../models');
const paymentService = require('../services/paymentService');
const { formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');

const paymentController = {
  async showGcashMockCheckout(req, res, next) {
    try {
      const ref = req.query.ref ? req.query.ref.trim() : null;
      if (!ref) {
        return res.redirect('/reservations');
      }

      const reservation = await Reservation.findOne({
        where: { reference_number: ref },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }]
      });

      if (!reservation) {
        return res.status(404).render('pages/error', {
          title: 'Invalid Payment Session',
          message: `The reservation with reference "${ref}" could not be found or has expired. Please create a new reservation.`,
          statusCode: 404,
          user: req.session ? req.session.user : null
        });
      }

      if (reservation.status === 'CONFIRMED') {
        return res.redirect(`/payment/success?ref=${reservation.reference_number}`);
      }

      if (reservation.status === 'EXPIRED' || (new Date() > new Date(reservation.expires_at))) {
        reservation.status = 'EXPIRED';
        await reservation.save();
        return res.render('pages/payment-failed', {
          title: 'Payment Expired - PicklePlay Pro',
          reason: 'Your 15-minute payment session has expired. The time slot has been released for other players.',
          reservation,
          user: req.session ? req.session.user : null
        });
      }

      res.render('pages/gcash-mock', {
        title: 'GCash Secure Checkout',
        layout: false,
        reservation,
        formatCurrency,
        formatTime12,
        user: req.session ? req.session.user : null
      });
    } catch (err) {
      next(err);
    }
  },

  async processGcashMockPayment(req, res, next) {
    try {
      const { reference_number, gcash_mobile, simulate_failure } = req.body;
      const ref = reference_number ? reference_number.trim() : '';

      if (simulate_failure === 'true') {
        return res.render('pages/payment-failed', {
          title: 'Payment Unsuccessful',
          reason: 'The transaction was cancelled or declined by GCash simulator.',
          reservation: { reference_number: ref },
          user: req.session ? req.session.user : null
        });
      }

      const txnId = `GCASH-PAY-${Date.now()}`;
      await paymentService.processPaymentSuccess(ref, txnId, 'GCASH');

      res.redirect(`/payment/success?ref=${ref}`);
    } catch (err) {
      next(err);
    }
  },

  async handleGcashWebhook(req, res) {
    try {
      const signature = req.headers['x-gcash-signature'] || req.headers['x-paymongo-signature'];
      const isValid = paymentService.verifyWebhookSignature(signature, req.body);

      if (!isValid) {
        return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      }

      const { reference_number, transaction_id, status } = req.body;
      const ref = reference_number ? reference_number.trim() : '';

      if (status === 'SUCCESS' || status === 'PAID' || status === 'CONFIRMED') {
        await paymentService.processPaymentSuccess(ref, transaction_id, 'GCASH_WEBHOOK');
      }

      res.json({ success: true, message: 'Webhook processed successfully' });
    } catch (err) {
      console.error('[Webhook Error]:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  async showPaymentSuccess(req, res, next) {
    try {
      const ref = req.query.ref ? req.query.ref.trim() : null;
      const reservation = await Reservation.findOne({
        where: { reference_number: ref },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }]
      });

      if (!reservation) {
        return res.redirect('/');
      }

      res.render('pages/payment-success', {
        title: 'Payment Successful! - PicklePlay Pro',
        reservation,
        formatCurrency,
        formatTime12,
        user: req.session ? req.session.user : null
      });
    } catch (err) {
      next(err);
    }
  },

  async showPaymentFailed(req, res) {
    res.render('pages/payment-failed', {
      title: 'Payment Failed',
      reason: req.query.reason || 'Payment could not be completed at this time.',
      reservation: { reference_number: req.query.ref || 'N/A' },
      user: req.session ? req.session.user : null
    });
  }
};

module.exports = paymentController;
