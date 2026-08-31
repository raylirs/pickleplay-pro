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

// Session & Flash
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'pickleplay_session_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
  })
);

app.use(flash());

// Global template variables & helper functions
app.use((req, res, next) => {
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

async function bootstrap() {
  try {
    await sequelize.authenticate();
    console.log('[Database] Connection established successfully.');

    await seedDatabase();

    startExpirationWorker();
    const { startMessengerSyncWorker } = require('./services/messengerSyncWorker');
    startMessengerSyncWorker();

    server.listen(PORT, () => {
      console.log('====================================================');
      console.log(`3KS Playground Server running at: http://localhost:${PORT}`);
      console.log(`Admin Dashboard available at:  http://localhost:${PORT}/admin`);
      console.log(`Real-Time Socket.io: Enabled`);
      console.log(`GCash Payment System: Enabled`);
      console.log('====================================================');
    });
  } catch (err) {
    console.error('[Bootstrap Error]:', err);
    process.exit(1);
  }
}

bootstrap();
