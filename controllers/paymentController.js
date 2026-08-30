const { Reservation, Court, CourtCategory, SystemSetting } = require('../models');
const { getIO } = require('../config/socket');
const { formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');
const { logAudit } = require('../utils/helpers');

const paymentController = {
  async showGcashPaymentPage(req, res, next) {
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
          title: 'Invalid Booking Reference',
          message: `The reservation with reference "${ref}" was not found. Please create a new booking.`,
          statusCode: 404,
          user: req.session ? req.session.user : null
        });
      }

      if (reservation.status === 'CONFIRMED') {
        req.flash('success', 'Your reservation is already confirmed!');
        return res.redirect(`/reservations/${reservation.reference_number}`);
      }

      if (reservation.status === 'AWAITING_CONFIRMATION') {
        req.flash('success', 'Your payment proof was already submitted and is awaiting admin approval.');
        return res.redirect(`/reservations/${reservation.reference_number}`);
      }

      const qrSetting = await SystemSetting.findByPk('GCASH_QR_IMAGE');
      const nameSetting = await SystemSetting.findByPk('GCASH_ACCOUNT_NAME');
      const numSetting = await SystemSetting.findByPk('GCASH_ACCOUNT_NUMBER');

      res.render('pages/gcash-payment', {
        title: 'GCash QR Payment - 3KS Pickleball Playground',
        reservation,
        gcashQrImage: qrSetting ? qrSetting.value : '/images/gcash-qr.jpg',
        gcashAccountName: nameSetting ? nameSetting.value : 'RY*N KR******R L.',
        gcashAccountNumber: numSetting ? numSetting.value : '0939-075-XXXX',
        formatCurrency,
        formatTime12,
        user: req.session ? req.session.user : null
      });
    } catch (err) {
      next(err);
    }
  },

  async submitPaymentProof(req, res, next) {
    try {
      const { reference_number, gcash_reference_no } = req.body;
      const ref = reference_number ? reference_number.trim() : '';

      const reservation = await Reservation.findOne({
        where: { reference_number: ref },
        include: [{ model: Court, as: 'court' }]
      });

      if (!reservation) {
        req.flash('error', 'Reservation not found.');
        return res.redirect('/reservations');
      }

      reservation.gcash_reference_no = gcash_reference_no ? gcash_reference_no.trim() : null;
      if (req.file) {
        reservation.payment_screenshot = `/uploads/courts/${req.file.filename}`;
      }
      reservation.status = 'AWAITING_CONFIRMATION';
      await reservation.save();

      await logAudit('PAYMENT_PROOF_SUBMITTED', {
        referenceNumber: reservation.reference_number,
        court: reservation.court ? reservation.court.display_name : 'Court',
        gcashRef: reservation.gcash_reference_no,
        amount: reservation.total_amount
      });

      // Real-time broadcast to Admin
      try {
        const io = getIO();
        io.emit('payment_submitted_for_approval', {
          reference: reservation.reference_number,
          courtName: reservation.court ? reservation.court.display_name : 'Court',
          playerName: reservation.user_name,
          date: reservation.reservation_date,
          time: reservation.start_time,
          amount: reservation.total_amount,
          gcashRef: reservation.gcash_reference_no
        });
      } catch (socketErr) {
        console.warn('Socket broadcast warning:', socketErr.message);
      }

      req.flash('success', 'GCash payment proof submitted successfully! The admin will verify and confirm your slot.');
      res.redirect(`/reservations/${reservation.reference_number}`);
    } catch (err) {
      next(err);
    }
  },

  async handleGcashWebhook(req, res) {
    res.json({ success: true, message: 'Webhook receiver ready.' });
  },

  async showPaymentSuccess(req, res) {
    const { ref } = req.query;
    res.redirect(`/reservations/${ref || ''}`);
  }
};

module.exports = paymentController;
