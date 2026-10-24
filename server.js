process.env.TZ = process.env.TZ || 'Asia/Manila';

const http = require('http');
const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const flash = require('connect-flash');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const { sequelize } = require('./models');
const { initSocket } = require('./config/socket');
const { startExpirationWorker } = require('./services/expirationWorker');
const seedDatabase = require('./seeds/seed');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { formatCurrency, formatTime12, formatDate } = require('./utils/dateTimeUtils');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
initSocket(server);

// Security Middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(cors());

// Body Parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session & Flash (Rolling 15-Minute Inactivity Session Timeout)
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'pickleplay_session_secret_key',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_IDLE_TIMEOUT_MS
    }
  })
);

app.use(flash());

// Enforce server-side idle session timeout & expose global template variables
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    const now = Date.now();
    const isBackgroundPoll = req.path === '/courts-availability' || req.query._bg === '1';
    if (req.session.lastActiveAt && (now - req.session.lastActiveAt > SESSION_IDLE_TIMEOUT_MS)) {
      delete req.session.user;
      delete req.session.lastActiveAt;
    } else if (!isBackgroundPoll) {
      req.session.lastActiveAt = now;
    }
  }
  res.locals.user = req.session ? req.session.user : null;
  res.locals.error = req.flash('error');
  res.locals.success = req.flash('success');
  res.locals.formatCurrency = formatCurrency;
  res.locals.formatTime12 = formatTime12;
  res.locals.formatDate = formatDate;
  next();
});

// View Engine (EJS + Layouts)
app.use(expressLayouts);
app.set('layout', 'layouts/main');
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/', routes);

// 404 & Global Error Handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Database Sync & Startup
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, async () => {
  console.log('====================================================');
  console.log(`The Playground Pickleball Server running on http://${HOST}:${PORT}`);
  console.log(`Admin Dashboard available at:  http://${HOST}:${PORT}/admin`);
  console.log(`Real-Time Socket.io: Enabled`);
  console.log(`GCash Payment System: Enabled`);
  console.log(`Render Port Binding: Confirmed on ${PORT}`);
  console.log('====================================================');

  try {
    await sequelize.authenticate();
    console.log('[Database] Connection established successfully.');

    await seedDatabase();

    startExpirationWorker();
    const { startMessengerSyncWorker } = require('./services/messengerSyncWorker');
    startMessengerSyncWorker();
    console.log('[Bootstrap] All background workers and database initialized.');
  } catch (err) {
    console.error('[Database/Worker Init Warning]:', err.message || err);
  }
});

module.exports = { app, server };
