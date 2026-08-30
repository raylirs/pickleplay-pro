const express = require('express');
const router = express.Router();
const webRoutes = require('./web');
const apiRoutes = require('./api');
const adminRoutes = require('./admin');

router.use('/api', apiRoutes);
router.use('/admin', adminRoutes);
router.use('/', webRoutes);

module.exports = router;
