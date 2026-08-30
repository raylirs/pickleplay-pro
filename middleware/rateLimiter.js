const rateLimit = require('express-rate-limit');

const reservationLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW, 10) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  message: {
    success: false,
    error: 'Too many reservation requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { reservationLimiter };
