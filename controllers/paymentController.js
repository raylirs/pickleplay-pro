const { Reservation, Court, CourtCategory, SystemSetting } = require('../models');
const { Op } = require('sequelize');
const { getIO } = require('../config/socket');
const { formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');
const { logAudit } = require('../utils/helpers');

function isReservationOwner(reservation, currentUser) {
  if (!reservation || !currentUser) return false;
  if (currentUser.role === 'admin' || currentUser.role === 'staff') return true;
  if (currentUser.id && reservation.user_id && Number(currentUser.id) === Number(reservation.user_id)) {
    return true;
  }
  if (currentUser.phone && reservation.user_contact && reservation.user_contact === currentUser.phone) {
    return true;
  }
  if (
    currentUser.email &&
    reservation.user_email &&
    reservation.user_email.toLowerCase() === currentUser.email.toLowerCase()
  ) {
    return true;
  }
  return false;
}

const paymentController = {
  async showGcashPaymentPage(req, res, next) {
    try {
      const ref = req.query.ref ? req.query.ref.trim() : null;
      if (!ref) {
        return res.redirect('/reservations');
      }

      const reservation = await Reservation.findOne({
        where: {
          [Op.or]: [
            { reference_number: ref },
            { user_contact: ref }
          ]
        },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
        order: [['id', 'DESC']]
      });

      if (!reservation) {
        return res.status(404).render('pages/error', {
          title: 'Invalid Booking Reference',
          message: `The reservation with reference "${ref}" was not found. Please create a new booking.`,
          statusCode: 404,
          user: req.session ? req.session.user : null
        });
      }

      const currentUser = req.session ? req.session.user : null;
      if (!currentUser) {
        req.flash('error', 'Please sign in to the player account that created this booking to continue payment.');
        return res.redirect(`/account/login?returnTo=${encodeURIComponent('/payment/gcash?ref=' + reservation.reference_number)}`);
      }

      if (!isReservationOwner(reservation, currentUser)) {
        return res.status(403).render('pages/error', {
          title: 'Unauthorized Transaction Access',
          message: 'This court reservation belongs to another player account. Only the player who created this booking can complete its payment.',
          statusCode: 403,
          user: currentUser
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
      const masterRef = reservation.reference_number.split('-')[0];
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
        user: currentUser,
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

      const currentUser = req.session ? req.session.user : null;
      if (!isReservationOwner(reservation, currentUser)) {
        req.flash('error', 'Unauthorized: Only the player who created this reservation can submit payment proof.');
        return res.redirect('/');
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

      // Real-time broadcast to Admin & all connected Player Matrices
      try {
        const io = getIO();
        for (const resv of allSiblings) {
          io.emit('court_availability_updated', {
            courtId: resv.court_id,
            date: resv.reservation_date,
            status: 'AWAITING_CONFIRMATION'
          });
        }
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

      // Dispatch Facebook Messenger alert to Admin & Player Profiles (Async)
      try {
        const totalOrderAmount = allSiblings.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
        const { notifyAdminPaymentProof, notifyPlayerPaymentSubmitted } = require('../services/facebookService');
        notifyAdminPaymentProof(reservation).catch(e => console.warn('[FB Notify Error]:', e.message));
        notifyPlayerPaymentSubmitted(reservation, totalOrderAmount).catch(e => console.warn('[FB Player Notify Error]:', e.message));

        const { notifyAdminsPaymentProofEmail } = require('../services/emailService');
        notifyAdminsPaymentProofEmail(reservation, totalOrderAmount).catch(e => console.warn('[Admin Payment Email Error]:', e.message));
      } catch (e) {}

      // Post automated Booking Card to Player In-App Account Chat
      try {
        const { postBookingSystemMessage } = require('../services/chatService');
        postBookingSystemMessage(reservation, 'PAYMENT_SUBMITTED').catch(e => console.warn('[Chat Notify Error]:', e.message));
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
