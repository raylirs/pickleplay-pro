const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const reservationController = require('../controllers/reservationController');
const paymentController = require('../controllers/paymentController');
const authController = require('../controllers/authController');
const chatController = require('../controllers/chatController');
const { requirePlayerAuth } = require('../middleware/auth');
const { reservationLimiter } = require('../middleware/rateLimiter');
const upload = require('../middleware/upload');
const { CourtCategory, Court, User } = require('../models');

const { formatCurrency, formatTime12, formatDate } = require('../utils/dateTimeUtils');

// Home page displaying The Playground Pickleball
router.get('/', async (req, res, next) => {
  try {
    const categories = await CourtCategory.findAll({
      include: [{ model: Court, as: 'courts' }],
      order: [['id', 'ASC']]
    });
    const courts = await Court.findAll({
      where: { is_active: true },
      include: [{ model: CourtCategory, as: 'category' }],
      order: [['court_number', 'ASC'], ['id', 'ASC']]
    });
    const today = formatDate(new Date());
    let currentUser = req.session ? req.session.user : null;
    if (currentUser && currentUser.id) {
      const dbUser = await User.findByPk(currentUser.id);
      if (dbUser) {
        if (!dbUser.binding_code) {
          dbUser.binding_code = 'PLAY-' + Math.floor(1000 + Math.random() * 9000);
          await dbUser.save();
        }
        currentUser.fb_psid = dbUser.fb_psid || null;
        currentUser.binding_code = dbUser.binding_code;
        req.session.user = currentUser;
      }
    }
    const myBookings = currentUser
      ? await reservationController.getPlayerReservationsGrouped(currentUser)
      : [];

    const playerBookedDates = {};
    if (myBookings && myBookings.length > 0) {
      myBookings.forEach(b => {
        if (b.status !== 'CANCELLED' && b.status !== 'EXPIRED' && b.status !== 'REFUNDED') {
          (b.dates || [b.reservation_date]).forEach(d => {
            playerBookedDates[d] = {
              referenceNumber: b.reference_number,
              status: b.status
            };
          });
        }
      });
    }

    res.render('pages/index', {
      title: 'The Playground Pickleball - Championship Courts Reservation',
      categories,
      courts,
      today,
      myBookings,
      playerBookedDates,
      formatCurrency,
      formatTime12,
      formatDate,
      user: currentUser,
      hideNavbar: true
    });
  } catch (err) {
    next(err);
  }
});

// Player Account Auth Routes
router.get('/account/login', authController.showPlayerLogin);
router.post('/account/login', authController.playerLogin);
router.get('/account/register', authController.showPlayerRegister);
router.post('/account/register', authController.playerRegister);
router.post('/account/verify-otp', authController.verifyEmailOtp);
router.post('/account/resend-otp', authController.resendEmailOtp);
router.post('/account/forgot-password', authController.forgotPasswordRequest);
router.post('/account/reset-password', authController.resetPasswordWithOtp);
router.get('/account/logout', authController.playerLogout);
router.post('/account/logout', authController.playerLogout);

// My Bookings shortcut & JSON API
router.get('/my-bookings', requirePlayerAuth, (req, res) => {
  res.redirect('/#my-bookings');
});
router.get('/api/my-bookings', reservationController.getMyBookingsJson);

// In-App Account Chat & Booking Cards JSON API
router.get('/api/account/chat', chatController.getAccountChatJson);
router.post('/api/account/chat', chatController.sendPlayerChatMessage);
router.post('/api/account/chat/read', chatController.markPlayerChatRead);

// JSON endpoint for real-time court availability matrix and calendar month status
router.get('/courts-availability', courtController.getAllCourtsAvailabilityJson);
router.get('/calendar-month-status', courtController.getCalendarMonthStatusJson);

// Courts listing & detail
router.get('/courts', courtController.getPublicCourts);
router.get('/courts/:id', courtController.getCourtDetail);

// Public reservation pages (strict player login required to book)
router.get('/reservations', (req, res) => res.redirect('/#book'));
router.post('/reservations', requirePlayerAuth, reservationLimiter, reservationController.createReservation);
router.get('/reservations/lookup', reservationController.showLookupPage);
router.get('/reservations/:reference', reservationController.getReservationByReference);

// GCash QR Payment flow
router.get('/payment/gcash', paymentController.showGcashPaymentPage);
router.get('/payment/gcash-checkout', paymentController.showGcashPaymentPage);
router.post('/payment/submit-proof', upload.single('screenshot'), paymentController.submitPaymentProof);

// Facebook Messenger Webhook & Binding
const facebookService = require('../services/facebookService');
router.get('/webhook/facebook', facebookService.handleWebhookVerification);
router.post('/webhook/facebook', facebookService.handleWebhookEvents);

module.exports = router;
