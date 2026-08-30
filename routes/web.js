const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const reservationController = require('../controllers/reservationController');
const paymentController = require('../controllers/paymentController');
const { reservationLimiter } = require('../middleware/rateLimiter');
const upload = require('../middleware/upload');
const { CourtCategory, Court } = require('../models');

// Home page displaying 3KS Playground
router.get('/', async (req, res, next) => {
  try {
    const categories = await CourtCategory.findAll({
      include: [{ model: Court, as: 'courts' }],
      order: [['id', 'ASC']]
    });
    res.render('pages/index', {
      title: '3KS Pickleball Playground - Court Reservation',
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

// GCash QR Payment flow
router.get('/payment/gcash-checkout', paymentController.showGcashPaymentPage);
router.post('/payment/submit-proof', upload.single('screenshot'), paymentController.submitPaymentProof);

module.exports = router;
