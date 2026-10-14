const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const reservationController = require('../controllers/reservationController');
const paymentController = require('../controllers/paymentController');
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

    res.render('pages/index', {
      title: 'The Playground Pickleball - Championship Courts Reservation',
      categories,
      courts,
      today,
      formatCurrency,
      formatTime12,
      formatDate,
      user: req.session ? req.session.user : null,
      hideNavbar: true
    });
  } catch (err) {
    next(err);
  }
});

// JSON endpoint for real-time court availability matrix
router.get('/courts-availability', courtController.getAllCourtsAvailabilityJson);

// Courts listing & detail
router.get('/courts', courtController.getPublicCourts);
router.get('/courts/:id', courtController.getCourtDetail);

// Public reservation pages
router.get('/reservations', reservationController.showReservationPage);
router.post('/reservations', reservationLimiter, reservationController.createReservation);
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
