const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const reservationController = require('../controllers/reservationController');
const paymentController = require('../controllers/paymentController');
const authController = require('../controllers/authController');
const { requirePlayerAuth } = require('../middleware/auth');
const { reservationLimiter } = require('../middleware/rateLimiter');
const upload = require('../middleware/upload');
const { CourtCategory, Court } = require('../models');

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
    const currentUser = req.session ? req.session.user : null;
    const myBookings = currentUser
      ? await reservationController.getPlayerReservationsGrouped(currentUser)
      : [];

    res.render('pages/index', {
      title: 'The Playground Pickleball - Championship Courts Reservation',
      categories,
      courts,
      today,
      myBookings,
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
router.get('/account/logout', authController.playerLogout);
router.post('/account/logout', authController.playerLogout);

// My Bookings shortcut & JSON API
router.get('/my-bookings', requirePlayerAuth, (req, res) => {
  res.redirect('/#my-bookings');
});
router.get('/api/my-bookings', reservationController.getMyBookingsJson);

// JSON endpoint for real-time court availability matrix
router.get('/courts-availability', courtController.getAllCourtsAvailabilityJson);

// Courts listing & detail
router.get('/courts', courtController.getPublicCourts);
router.get('/courts/:id', courtController.getCourtDetail);

// Public reservation pages (strict player login required to book)
router.get('/reservations', requirePlayerAuth, reservationController.showReservationPage);
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
