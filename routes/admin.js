const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const authController = require('../controllers/authController');
const { requireAuth, redirectIfAuthenticated } = require('../middleware/auth');
const upload = require('../middleware/upload');

// Auth routes
router.get('/login', redirectIfAuthenticated, authController.showLogin);
router.post('/login', redirectIfAuthenticated, authController.login);
router.get('/logout', authController.logout);

// Protected Admin Dashboard
router.get('/', requireAuth, adminController.showDashboard);

// Court Management CRUD
router.get('/courts', requireAuth, adminController.showCourts);
router.get('/courts/new', requireAuth, adminController.showCourtForm);
router.post('/courts', requireAuth, upload.single('image'), adminController.createCourtCategory);
router.get('/courts/:id/edit', requireAuth, adminController.showCourtForm);
router.post('/courts/:id/update', requireAuth, upload.single('image'), adminController.updateCourtCategory);
router.post('/courts/:id/delete', requireAuth, adminController.deleteCourtCategory);
router.post('/courts/:id/toggle-status', requireAuth, adminController.toggleCourtStatus);

// Reservation Management
router.get('/reservations', requireAuth, adminController.showReservations);
router.get('/reservations/:id', requireAuth, adminController.showReservationDetail);
router.post('/reservations/:id/cancel', requireAuth, adminController.cancelReservation);
router.post('/reservations/:id/confirm', requireAuth, adminController.confirmReservation);

// QR Code & Payment Settings
router.get('/settings', requireAuth, adminController.showSettings);
router.post('/settings', requireAuth, upload.single('qr_image'), adminController.updateSettings);

// Facebook & Meta Notification Settings
router.get('/facebook', requireAuth, adminController.showFacebookSettings);
router.post('/facebook/save-settings', requireAuth, adminController.saveFacebookSettings);
router.post('/facebook/fetch-pages', requireAuth, adminController.fetchFacebookPages);
router.post('/facebook/connect-page', requireAuth, adminController.connectFacebookPage);
router.post('/facebook/test-notification', requireAuth, adminController.testFacebookNotification);

// User & Staff Accounts Management
router.get('/users', requireAuth, adminController.showUsers);
router.post('/users', requireAuth, adminController.createUser);
router.post('/users/:id/delete', requireAuth, adminController.deleteUser);

// Reports & CSV Export
router.get('/reports', requireAuth, adminController.showReports);
router.get('/reports/export-csv', requireAuth, adminController.exportReservationsCsv);

module.exports = router;
