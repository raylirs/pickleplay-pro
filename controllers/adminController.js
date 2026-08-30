const bcrypt = require('bcryptjs');
const { CourtCategory, Court, Reservation, AuditLog, User, SystemSetting, sequelize } = require('../models');
const { Op } = require('sequelize');
const { getCourtAvailability } = require('../services/availabilityService');
const { getIO } = require('../config/socket');
const { sendReservationConfirmation } = require('../services/emailService');
const { sendReservationSMS } = require('../services/smsService');
const { formatCurrency, formatDate, formatTime12 } = require('../utils/dateTimeUtils');
const { logAudit } = require('../utils/helpers');

const adminController = {
  async showDashboard(req, res, next) {
    try {
      const today = formatDate(new Date());
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

      const totalCourts = await Court.count();
      const activeCourts = await Court.count({ where: { is_active: true } });
      const totalReservations = await Reservation.count();
      const confirmedReservations = await Reservation.count({ where: { status: 'CONFIRMED' } });
      const pendingReservations = await Reservation.count({ where: { status: { [Op.in]: ['PENDING', 'AWAITING_PAYMENT'] } } });
      const cancelledReservations = await Reservation.count({ where: { status: 'CANCELLED' } });

      const allConfirmed = await Reservation.findAll({
        where: { status: 'CONFIRMED' },
        attributes: ['total_amount', 'reservation_date', 'created_at']
      });

      const totalRevenue = allConfirmed.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
      const todayRevenue = allConfirmed
        .filter(r => r.reservation_date === today)
        .reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
      const monthRevenue = allConfirmed
        .filter(r => new Date(r.reservation_date) >= startOfMonth)
        .reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);

      const recentReservations = await Reservation.findAll({
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
        order: [['created_at', 'DESC']],
        limit: 8
      });

      const recentAuditLogs = await AuditLog.findAll({
        order: [['created_at', 'DESC']],
        limit: 6
      });

      const last7Days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dStr = formatDate(d);
        const dayRev = allConfirmed
          .filter(r => r.reservation_date === dStr)
          .reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
        last7Days.push({ date: dStr, label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }), revenue: dayRev });
      }

      res.render('admin/dashboard', {
        title: 'Admin Dashboard - PicklePlay Pro',
        layout: 'layouts/admin',
        user: req.session.user,
        stats: {
          totalCourts,
          activeCourts,
          totalReservations,
          confirmedReservations,
          pendingReservations,
          cancelledReservations,
          totalRevenue,
          todayRevenue,
          monthRevenue
        },
        recentReservations,
        recentAuditLogs,
        chartData: JSON.stringify(last7Days),
        formatCurrency,
        formatDate,
        formatTime12,
        messages: {
          error: req.flash('error'),
          success: req.flash('success')
        }
      });
    } catch (err) {
      next(err);
    }
  },

  async showCourts(req, res, next) {
    try {
      const categories = await CourtCategory.findAll({
        include: [{ model: Court, as: 'courts' }],
        order: [['id', 'ASC']]
      });

      res.render('admin/courts', {
        title: 'Manage Courts - PicklePlay Pro',
        layout: 'layouts/admin',
        user: req.session.user,
        categories,
        formatCurrency,
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async showCourtForm(req, res, next) {
    try {
      const categoryId = req.params.id;
      let category = null;

      if (categoryId) {
        category = await CourtCategory.findByPk(categoryId, {
          include: [{ model: Court, as: 'courts' }]
        });
        if (!category) {
          req.flash('error', 'Court Category not found.');
          return res.redirect('/admin/courts');
        }
      }

      res.render('admin/court-form', {
        title: category ? `Edit ${category.name}` : 'Add New Court Category',
        layout: 'layouts/admin',
        user: req.session.user,
        category,
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async createCourtCategory(req, res, next) {
    try {
      const { name, description, price_per_hour, total_courts } = req.body;
      const count = parseInt(total_courts, 10) || 1;
      const price = parseFloat(price_per_hour);

      if (!name || isNaN(price) || price <= 0) {
        req.flash('error', 'Please provide a valid court name and price per hour.');
        return res.redirect('/admin/courts/new');
      }

      let imageUrl = '/img/default-court.jpg';
      if (req.file) {
        imageUrl = `/uploads/courts/${req.file.filename}`;
      }

      const category = await CourtCategory.create({
        name: name.trim(),
        description: description ? description.trim() : '',
        image_url: imageUrl,
        price_per_hour: price,
        total_courts: count
      });

      for (let i = 1; i <= count; i++) {
        await Court.create({
          category_id: category.id,
          court_number: i,
          display_name: `${category.name} - ${i}`,
          is_active: true
        });
      }

      await logAudit('COURT_CATEGORY_CREATED', {
        categoryId: category.id,
        name: category.name,
        totalCourts: count,
        price
      }, req.session.user.id);

      req.flash('success', `Court category "${category.name}" created with ${count} court(s).`);
      res.redirect('/admin/courts');
    } catch (err) {
      next(err);
    }
  },

  async updateCourtCategory(req, res, next) {
    try {
      const categoryId = req.params.id;
      const { name, description, price_per_hour, total_courts } = req.body;
      const category = await CourtCategory.findByPk(categoryId, {
        include: [{ model: Court, as: 'courts' }]
      });

      if (!category) {
        req.flash('error', 'Court Category not found.');
        return res.redirect('/admin/courts');
      }

      const newCount = parseInt(total_courts, 10) || category.total_courts;
      const price = parseFloat(price_per_hour) || category.price_per_hour;

      category.name = name.trim();
      category.description = description ? description.trim() : '';
      category.price_per_hour = price;

      if (req.file) {
        category.image_url = `/uploads/courts/${req.file.filename}`;
      }

      const currentCourtCount = category.courts.length;
      if (newCount > currentCourtCount) {
        for (let i = currentCourtCount + 1; i <= newCount; i++) {
          await Court.create({
            category_id: category.id,
            court_number: i,
            display_name: `${category.name} - ${i}`,
            is_active: true
          });
        }
      } else if (newCount < currentCourtCount) {
        const courtsToRemove = category.courts
          .sort((a, b) => b.court_number - a.court_number)
          .slice(0, currentCourtCount - newCount);

        for (const c of courtsToRemove) {
          await c.destroy();
        }
      }

      category.total_courts = newCount;
      await category.save();

      const updatedCourts = await Court.findAll({ where: { category_id: category.id } });
      for (const c of updatedCourts) {
        c.display_name = `${category.name} - ${c.court_number}`;
        await c.save();
      }

      await logAudit('COURT_CATEGORY_UPDATED', {
        categoryId: category.id,
        name: category.name,
        totalCourts: newCount,
        price
      }, req.session.user.id);

      req.flash('success', `Court category "${category.name}" updated successfully.`);
      res.redirect('/admin/courts');
    } catch (err) {
      next(err);
    }
  },

  async deleteCourtCategory(req, res, next) {
    try {
      const categoryId = req.params.id;
      const category = await CourtCategory.findByPk(categoryId);

      if (!category) {
        req.flash('error', 'Court category not found.');
        return res.redirect('/admin/courts');
      }

      const name = category.name;
      await category.destroy();

      await logAudit('COURT_CATEGORY_DELETED', { categoryId, name }, req.session.user.id);
      req.flash('success', `Court category "${name}" and all associated courts were deleted.`);
      res.redirect('/admin/courts');
    } catch (err) {
      next(err);
    }
  },

  async toggleCourtStatus(req, res, next) {
    try {
      const courtId = req.params.id;
      const court = await Court.findByPk(courtId, {
        include: [{ model: CourtCategory, as: 'category' }]
      });

      if (!court) {
        return res.status(404).json({ success: false, error: 'Court not found' });
      }

      court.is_active = !court.is_active;
      await court.save();

      await logAudit('COURT_STATUS_TOGGLED', {
        courtId: court.id,
        name: court.display_name,
        isActive: court.is_active
      }, req.session.user.id);

      try {
        const io = getIO();
        const today = formatDate(new Date());
        const avail = await getCourtAvailability(court.id, today);
        io.emit('court_availability_updated', {
          courtId: court.id,
          date: today,
          slots: avail.slots
        });
      } catch (e) {
        console.warn('Socket error on toggle:', e.message);
      }

      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({
          success: true,
          isActive: court.is_active,
          message: `${court.display_name} is now ${court.is_active ? 'Active' : 'Under Maintenance'}.`
        });
      }

      req.flash('success', `${court.display_name} status updated.`);
      res.redirect('/admin/courts');
    } catch (err) {
      next(err);
    }
  },

  async showReservations(req, res, next) {
    try {
      const { status, court_id, date, search } = req.query;
      const where = {};

      if (status && status !== 'ALL') {
        where.status = status;
      }
      if (court_id && court_id !== 'ALL') {
        where.court_id = court_id;
      }
      if (date) {
        where.reservation_date = date;
      }
      if (search) {
        where[Op.or] = [
          { reference_number: { [Op.like]: `%${search}%` } },
          { user_name: { [Op.like]: `%${search}%` } },
          { user_contact: { [Op.like]: `%${search}%` } },
          { user_email: { [Op.like]: `%${search}%` } }
        ];
      }

      const reservations = await Reservation.findAll({
        where,
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
        order: [['reservation_date', 'DESC'], ['start_time', 'ASC']]
      });

      const courts = await Court.findAll({ order: [['display_name', 'ASC']] });

      res.render('admin/reservations', {
        title: 'Manage Reservations - PicklePlay Pro',
        layout: 'layouts/admin',
        user: req.session.user,
        reservations,
        courts,
        filters: { status: status || 'ALL', court_id: court_id || 'ALL', date: date || '', search: search || '' },
        formatCurrency,
        formatDate,
        formatTime12,
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async showReservationDetail(req, res, next) {
    try {
      const id = req.params.id;
      const reservation = await Reservation.findByPk(id, {
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }]
      });

      if (!reservation) {
        req.flash('error', 'Reservation not found.');
        return res.redirect('/admin/reservations');
      }

      const auditLogs = await AuditLog.findAll({
        where: {
          details: { [Op.like]: `%${reservation.reference_number}%` }
        },
        order: [['created_at', 'DESC']]
      });

      res.render('admin/reservation-detail', {
        title: `Reservation ${reservation.reference_number} - PicklePlay Pro`,
        layout: 'layouts/admin',
        user: req.session.user,
        reservation,
        auditLogs,
        formatCurrency,
        formatDate,
        formatTime12,
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async cancelReservation(req, res, next) {
    try {
      const id = req.params.id;
      const { cancellation_reason } = req.body;
      const reservation = await Reservation.findByPk(id, {
        include: [{ model: Court, as: 'court' }]
      });

      if (!reservation) {
        req.flash('error', 'Reservation not found.');
        return res.redirect('/admin/reservations');
      }

      reservation.status = 'CANCELLED';
      reservation.cancellation_reason = cancellation_reason || 'Cancelled by Administrator';
      await reservation.save();

      await logAudit('RESERVATION_CANCELLED_BY_ADMIN', {
        referenceNumber: reservation.reference_number,
        reason: reservation.cancellation_reason
      }, req.session.user.id);

      try {
        const io = getIO();
        const avail = await getCourtAvailability(reservation.court_id, reservation.reservation_date);
        io.emit('court_availability_updated', {
          courtId: reservation.court_id,
          date: reservation.reservation_date,
          slots: avail.slots
        });
      } catch (e) {
        console.warn('Socket error on cancel:', e.message);
      }

      req.flash('success', `Reservation ${reservation.reference_number} cancelled.`);
      res.redirect(req.headers.referer || '/admin/reservations');
    } catch (err) {
      next(err);
    }
  },

  async confirmReservation(req, res, next) {
    try {
      const id = req.params.id;
      const reservation = await Reservation.findByPk(id, {
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }]
      });

      if (!reservation) {
        req.flash('error', 'Reservation not found.');
        return res.redirect('/admin/reservations');
      }

      reservation.status = 'CONFIRMED';
      reservation.payment_transaction_id = `ADMIN-MANUAL-${Date.now()}`;
      await reservation.save();

      await logAudit('RESERVATION_MANUALLY_CONFIRMED', {
        referenceNumber: reservation.reference_number,
        adminUser: req.session.user.username
      }, req.session.user.id);

      await sendReservationConfirmation(reservation, reservation.court);
      await sendReservationSMS(reservation, reservation.court);

      try {
        const io = getIO();
        const avail = await getCourtAvailability(reservation.court_id, reservation.reservation_date);
        io.emit('court_availability_updated', {
          courtId: reservation.court_id,
          date: reservation.reservation_date,
          slots: avail.slots
        });
        io.emit('payment_confirmed', {
          reference: reservation.reference_number,
          courtId: reservation.court_id,
          courtName: reservation.court.display_name,
          date: reservation.reservation_date,
          startTime: reservation.start_time,
          endTime: reservation.end_time,
          amount: reservation.total_amount
        });
      } catch (e) {
        console.warn('Socket error on manual confirm:', e.message);
      }

      req.flash('success', `Reservation ${reservation.reference_number} confirmed manually.`);
      res.redirect(req.headers.referer || '/admin/reservations');
    } catch (err) {
      next(err);
    }
  },

  async showReports(req, res, next) {
    try {
      const { start_date, end_date } = req.query;
      const today = formatDate(new Date());
      const startDate = start_date || formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
      const endDate = end_date || today;

      const reservations = await Reservation.findAll({
        where: {
          reservation_date: {
            [Op.between]: [startDate, endDate]
          }
        },
        include: [{ model: Court, as: 'court' }],
        order: [['reservation_date', 'DESC']]
      });

      const confirmed = reservations.filter(r => r.status === 'CONFIRMED');
      const totalRevenue = confirmed.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
      const totalHours = confirmed.reduce((sum, r) => sum + parseInt(r.total_hours || 0, 10), 0);

      res.render('admin/reports', {
        title: 'Revenue & Booking Reports - PicklePlay Pro',
        layout: 'layouts/admin',
        user: req.session.user,
        startDate,
        endDate,
        reservations,
        totalRevenue,
        totalHours,
        confirmedCount: confirmed.length,
        formatCurrency,
        formatDate,
        formatTime12
      });
    } catch (err) {
      next(err);
    }
  },

  async exportReservationsCsv(req, res, next) {
    try {
      const { start_date, end_date } = req.query;
      const where = {};
      if (start_date && end_date) {
        where.reservation_date = { [Op.between]: [start_date, end_date] };
      }

      const reservations = await Reservation.findAll({
        where,
        include: [{ model: Court, as: 'court' }],
        order: [['reservation_date', 'DESC']]
      });

      let csv = 'Reference Number,Court,Date,Start Time,End Time,Hours,Amount (PHP),Status,Player Name,Contact,Email,Payment Ref,Created At\n';

      reservations.forEach(r => {
        const row = [
          `"${r.reference_number}"`,
          `"${r.court ? r.court.display_name : 'N/A'}"`,
          `"${r.reservation_date}"`,
          `"${r.start_time}"`,
          `"${r.end_time}"`,
          r.total_hours,
          r.total_amount,
          `"${r.status}"`,
          `"${r.user_name.replace(/"/g, '""')}"`,
          `"${r.user_contact}"`,
          `"${r.user_email || ''}"`,
          `"${r.payment_transaction_id || ''}"`,
          `"${r.created_at}"`
        ];
        csv += row.join(',') + '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=reservations-report-${formatDate(new Date())}.csv`);
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  },

  async showSettings(req, res, next) {
    try {
      const qrSetting = await SystemSetting.findByPk('GCASH_QR_IMAGE');
      const nameSetting = await SystemSetting.findByPk('GCASH_ACCOUNT_NAME');
      const numSetting = await SystemSetting.findByPk('GCASH_ACCOUNT_NUMBER');

      res.render('admin/settings', {
        title: 'GCash Payment & Facility Settings - 3KS Playground',
        layout: 'layouts/admin',
        user: req.session.user,
        gcashQrImage: qrSetting ? qrSetting.value : '/images/gcash-qr.jpg',
        gcashAccountName: nameSetting ? nameSetting.value : 'RY*N KR******R L.',
        gcashAccountNumber: numSetting ? numSetting.value : '0939-075-XXXX',
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async updateSettings(req, res, next) {
    try {
      const { gcash_account_name, gcash_account_number } = req.body;

      if (req.file) {
        const qrUrl = `/uploads/courts/${req.file.filename}`;
        await SystemSetting.upsert({
          key: 'GCASH_QR_IMAGE',
          value: qrUrl,
          description: 'Uploaded GCash QR Code Image'
        });
      }

      if (gcash_account_name) {
        await SystemSetting.upsert({
          key: 'GCASH_ACCOUNT_NAME',
          value: gcash_account_name.trim(),
          description: 'Merchant GCash Account Name'
        });
      }

      if (gcash_account_number) {
        await SystemSetting.upsert({
          key: 'GCASH_ACCOUNT_NUMBER',
          value: gcash_account_number.trim(),
          description: 'Merchant GCash Mobile Number'
        });
      }

      await logAudit('SETTINGS_UPDATED', {
        gcashAccountName: gcash_account_name,
        gcashAccountNumber: gcash_account_number,
        newQrUploaded: !!req.file
      }, req.session.user.id);

      req.flash('success', 'GCash QR Code & Payment settings updated successfully!');
      res.redirect('/admin/settings');
    } catch (err) {
      next(err);
    }
  },

  async showUsers(req, res, next) {
    try {
      const users = await User.findAll({
        order: [['created_at', 'ASC']],
        attributes: ['id', 'username', 'role', 'created_at']
      });

      res.render('admin/users', {
        title: 'Admin & Staff Accounts - 3KS Playground',
        layout: 'layouts/admin',
        user: req.session.user,
        users,
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async createUser(req, res, next) {
    try {
      const { username, password, role } = req.body;
      if (!username || !password) {
        req.flash('error', 'Username and password are required.');
        return res.redirect('/admin/users');
      }

      const existing = await User.findOne({ where: { username: username.trim().toLowerCase() } });
      if (existing) {
        req.flash('error', `User "${username}" already exists.`);
        return res.redirect('/admin/users');
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await User.create({
        username: username.trim().toLowerCase(),
        password_hash: passwordHash,
        role: role || 'admin'
      });

      await logAudit('USER_CREATED', { createdUser: username, role }, req.session.user.id);
      req.flash('success', `Account "${username}" created successfully.`);
      res.redirect('/admin/users');
    } catch (err) {
      next(err);
    }
  },

  async deleteUser(req, res, next) {
    try {
      const id = req.params.id;
      const targetUser = await User.findByPk(id);

      if (!targetUser) {
        req.flash('error', 'User not found.');
        return res.redirect('/admin/users');
      }

      if (targetUser.id === req.session.user.id) {
        req.flash('error', 'You cannot delete your own logged-in account.');
        return res.redirect('/admin/users');
      }

      const count = await User.count();
      if (count <= 1) {
        req.flash('error', 'Cannot delete the only remaining admin account.');
        return res.redirect('/admin/users');
      }

      const username = targetUser.username;
      await targetUser.destroy();

      await logAudit('USER_DELETED', { deletedUser: username }, req.session.user.id);
      req.flash('success', `Account "${username}" was deleted.`);
      res.redirect('/admin/users');
    } catch (err) {
      next(err);
    }
  }
};

module.exports = adminController;
