const { Reservation, Court, CourtCategory, SystemSetting } = require('../models');
const { Op } = require('sequelize');
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

      // Find all sibling court reservations booked in the same order
      const masterRef = ref.split('-')[0];
      const siblingReservations = await Reservation.findAll({
        where: {
          reference_number: {
            [Op.or]: [
              masterRef,
              { [Op.like]: `${masterRef}-%` }
            ]
          }
        },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
        order: [['id', 'ASC']]
      });

      const totalOrderAmount = siblingReservations.length > 0
        ? siblingReservations.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0)
        : parseFloat(reservation.total_amount || 0);

      res.render('pages/gcash-payment', {
        title: `GCash QR Payment - ${reservation.reference_number}`,
        reservation,
        siblingReservations,
        totalOrderAmount,
        gcashQrImage: qrSetting ? qrSetting.value : '/images/gcash-qr.jpg',
        gcashAccountName: nameSetting ? nameSetting.value : 'RY*N KR******R L.',
        gcashAccountNumber: numSetting ? numSetting.value : '0939-075-XXXX',
        formatCurrency,
        formatTime12,
        user: req.session ? req.session.user : null,
        hideNavbar: true
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

      if (!gcash_reference_no || !gcash_reference_no.trim()) {
        req.flash('error', 'GCash Reference Number is required.');
        return res.redirect(`/payment/gcash-checkout?ref=${ref}`);
      }

      if (!req.file) {
        req.flash('error', 'Please upload your GCash payment screenshot as proof of payment.');
        return res.redirect(`/payment/gcash-checkout?ref=${ref}`);
      }

      const screenshotPath = `/uploads/courts/${req.file.filename}`;
      const gcashRefClean = gcash_reference_no.trim();

      // Find and update all sibling court reservations under this master order
      const masterRef = ref.split('-')[0];
      const allSiblings = await Reservation.findAll({
        where: {
          reference_number: {
            [Op.or]: [
              masterRef,
              { [Op.like]: `${masterRef}-%` }
            ]
          }
        },
        include: [{ model: Court, as: 'court' }]
      });

      for (const resv of allSiblings) {
        resv.gcash_reference_no = gcashRefClean;
        resv.payment_screenshot = screenshotPath;
        resv.status = 'AWAITING_CONFIRMATION';
        await resv.save();
      }

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

      // Dispatch Facebook Messenger alert to Admin Profile (Async)
      try {
        const { notifyAdminPaymentProof } = require('../services/facebookService');
        notifyAdminPaymentProof(reservation).catch(e => console.warn('[FB Notify Error]:', e.message));
      } catch (e) {}

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
