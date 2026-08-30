const express = require('express');
const router = express.Router();
const courtController = require('../controllers/courtController');
const reservationController = require('../controllers/reservationController');
const paymentController = require('../controllers/paymentController');

// RESTful JSON API endpoints
router.get('/courts', courtController.getPublicCourts);
router.get('/courts/:id/availability', courtController.getCourtAvailabilityJson);
router.post('/reservations/check-availability', reservationController.checkAvailability);
router.post('/reservations', reservationController.createReservation);
router.get('/reservations/:reference/status', reservationController.getReservationStatusJson);
router.post('/webhook/gcash-payment', paymentController.handleGcashWebhook);

module.exports = router;
