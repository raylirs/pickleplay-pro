const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const reservationController = require('../controllers/reservationController');
const paymentController = require('../controllers/paymentController');
const { reservationLimiter } = require('../middleware/rateLimiter');
const { CourtCategory, Court } = require('../models');

// Home page displaying all courts
router.get('/', async (req, res, next) => {
  try {
    const categories = await CourtCategory.findAll({
      include: [{ model: Court, as: 'courts' }],
      order: [['id', 'ASC']]
    });
    res.render('pages/index', {
      title: 'PicklePlay Pro - Premier Pickleball Court Reservations',
      categories,
      user: req.session ? req.session.user : null
    });
  } catch (err) {
    next(err);
  }
});

// Courts listing & detail
router.get('/courts', courtController.getPublicCourts);
router.get('/courts/:id', courtController.getCourtDetail);

// Public reservation pages
router.get('/reservations', reservationController.showReservationPage);
router.post('/reservations', reservationLimiter, reservationController.createReservation);
router.get('/reservations/lookup', reservationController.showLookupPage);
router.get('/reservations/:reference', reservationController.getReservationByReference);

// Payment flow
router.get('/payment/gcash-checkout', paymentController.showGcashMockCheckout);
router.post('/payment/gcash-mock-pay', paymentController.processGcashMockPayment);
router.get('/payment/success', paymentController.showPaymentSuccess);
router.get('/payment/failed', paymentController.showPaymentFailed);

// Webhook
router.post('/webhook/gcash-payment', paymentController.handleGcashWebhook);

module.exports = router;
