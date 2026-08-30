# 🏓 PicklePlay Pro - Court Reservation & GCash Payment System

**PicklePlay Pro** is a full-featured, production-ready web application for automated pickleball court reservations. Built with **Node.js**, **Express.js**, **EJS**, **Sequelize ORM**, **Bootstrap 5**, and **Socket.io**, it features real-time court availability updates, GCash payment gateway integration with simulated checkout & webhook handling, and an administrative control panel.

---

## 🌟 Key Features

### 1. 🏟️ Dynamic Court Management (Admin Panel)
- **Protected Admin Area**: Authenticated sessions with bcrypt password hashing at `/admin`.
- **Multi-Court Generation**: When creating a court category (e.g. "Grand Championship Court" with 2 courts), the system generates individual court entities (`Grand Championship Court - 1`, `Grand Championship Court - 2`).
- **Court CRUD & Maintenance**: Create, edit, delete, and toggle individual court maintenance modes with live synchronization.
- **Image Uploads**: Multer-powered image upload supporting JPG, PNG, and WebP.
- **Dynamic Pricing**: Custom hourly rate per court category in Philippine Pesos (₱).

### 2. ⚡ Public-Facing Reservation System
- **Court Showcase & Catalog**: Modern responsive grid layout displaying courts, amenities, and hourly rates.
- **Interactive Availability Calendar**: Live slot matrix from 8:00 AM to 10:00 PM showing available vs. booked slots.
- **Multi-Hour Booking**: Select duration from 1 to 4 hours with conflict detection.
- **Real-Time Slot Synchronization**: Powered by **Socket.io** — when a user books or pays, the slot updates across all active screens in real-time.
- **Booking Reference Search**: Quick lookup (`/reservations/lookup`) for receipts using reference IDs (`PKL-YYYY-XXXX`).

### 3. 💳 GCash Payment & Webhook Integration
- **15-Minute Slot Expiry**: Holds court slot for 15 minutes while awaiting payment before automatically releasing it back to the public pool via background worker.
- **Interactive GCash Checkout Simulator**: Realistic GCash checkout with mobile number entry, 6-digit OTP, and 4-digit MPIN.
- **Webhook Endpoint**: `POST /webhook/gcash-payment` with payload signature verification.
- **Notifications**: Automated Email & SMS confirmation dispatch with access details upon payment.

### 4. 📊 Admin Dashboard & Reports
- **Executive Metrics**: Today's revenue, all-time revenue, active court count, and booking statuses.
- **Visual Analytics**: Interactive 7-Day Revenue Trend chart powered by Chart.js.
- **Reservation Control**: Filter by status (`CONFIRMED`, `AWAITING_PAYMENT`, `CANCELLED`, `EXPIRED`), court, and date.
- **Manual Overrides**: Admin manual payment confirmation or cancellation with recorded reasons.
- **Audit Logs**: Activity logging for admin actions.
- **CSV Data Export**: One-click CSV export of bookings for accounting.

---

## 🛠️ Technology Stack

| Component | Technology |
|---|---|
| **Runtime** | Node.js (v18+) |
| **Framework** | Express.js |
| **View Engine** | EJS (Embedded JavaScript) with `express-ejs-layouts` |
| **Database** | SQLite (Default for zero-setup) & PostgreSQL (Configurable) via Sequelize ORM |
| **Real-time** | Socket.io |
| **Styling** | Bootstrap 5, Bootstrap Icons, Google Fonts |
| **File Storage** | Multer local storage (`public/uploads/courts/`) |
| **Security** | Helmet, Express-Session, Express-Rate-Limit, Bcrypt.js |

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Initialize & Seed Database
```bash
npm run seed
```
*Seeds default admin credentials and 3 starter court categories (6 individual courts).*

### 3. Start the Server
```bash
npm start
```
*Access the application at: [http://localhost:3000](http://localhost:3000)*

---

## 🔐 Default Admin Credentials

- **URL**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **Username**: `admin`
- **Password**: `admin123`

---

## 📂 Project Structure

```text
pickleplay-pro/
├── config/
│   ├── database.js          # Sequelize DB config (SQLite / PostgreSQL)
│   └── socket.js            # Socket.io server configuration
├── controllers/
│   ├── adminController.js   # Admin dashboard, court CRUD & reports
│   ├── authController.js    # Login/logout authentication
│   ├── courtController.js   # Public court browsing & availability
│   ├── paymentController.js # GCash checkout simulation & webhooks
│   └── reservationController.js # Booking creation & reference lookup
├── middleware/
│   ├── auth.js              # Session & role protection
│   ├── errorHandler.js      # 404 & 500 error handlers
│   ├── rateLimiter.js       # Rate limiters on reservation endpoints
│   └── upload.js            # Multer image upload handler
├── models/
│   ├── index.js             # Model associations
│   ├── User.js              # Admin users
│   ├── CourtCategory.js     # Court category templates
│   ├── Court.js             # Individual sub-courts
│   ├── Reservation.js       # Reservation records
│   └── AuditLog.js          # Action audit trails
├── public/
│   ├── css/                 # Custom styles & Bootstrap overrides
│   ├── js/                  # Client-side Socket.io & reservation logic
│   └── uploads/courts/      # Uploaded court images
├── routes/
│   ├── admin.js             # Protected /admin routes
│   ├── api.js               # RESTful JSON endpoints
│   ├── index.js             # Main router
│   └── web.js               # Public pages
├── seeds/
│   └── seed.js              # Database seed script
├── services/
│   ├── availabilityService.js # Slot generation & overlap detection
│   ├── emailService.js      # Confirmation email sender
│   ├── expirationWorker.js  # 15-minute unpaid expiry cron
│   ├── paymentService.js    # GCash payment & webhook processor
│   └── smsService.js        # Confirmation SMS sender
├── tests/
│   ├── syntax-check.js      # Syntax validator
│   └── verify.js            # End-to-end integration tests
├── utils/
│   ├── dateTimeUtils.js     # Time formatting (12h/24h) & ₱ currency
│   ├── generateReference.js # Reference number generator (PKL-YYYY-XXXX)
│   ├── helpers.js           # Audit logger
│   └── validators.js        # Phone/email validators
├── views/
│   ├── admin/               # Admin dashboard, courts, reservations, reports
│   ├── layouts/             # main, admin, and auth layouts
│   ├── pages/               # Public home, courts, reservation, GCash, receipt
│   └── partials/            # Navbars and footers
├── .env                     # Configuration variables
├── package.json
└── server.js                # Application entry point
```

---

## 🧪 Running Integration Tests

Run the test suite to verify database seeding, court availability checking, slot conflict prevention, reservation booking, GCash simulation, and webhook processing:

```bash
node tests/verify.js
```

---

## 📡 RESTful API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/courts` | List all court categories and child courts |
| `GET` | `/api/courts/:id/availability?date=YYYY-MM-DD` | Get slots for specific court and date |
| `POST` | `/api/reservations/check-availability` | Check if a multi-hour slot range is available |
| `POST` | `/api/reservations` | Create a new reservation & initiate payment |
| `GET` | `/api/reservations/:reference/status` | Query real-time status of a reservation |
| `POST` | `/webhook/gcash-payment` | Webhook receiver for GCash payment gateway |

---

## 📄 License
This project is licensed under the MIT License.
