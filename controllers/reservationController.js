const { Reservation, Court, CourtCategory } = require('../models');
const { Op } = require('sequelize');
const { isSlotRangeAvailable, areSlotsAvailable, getCourtAvailability } = require('../services/availabilityService');
const paymentService = require('../services/paymentService');
const { getIO } = require('../config/socket');
const { generateReferenceNumber } = require('../utils/generateReference');
const { addHoursToTime, formatDate, formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');
const { isValidPhilippineMobile, isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/helpers');

const reservationController = {
  async showReservationPage(req, res, next) {
    try {
      const courts = await Court.findAll({
        where: { is_active: true },
        include: [{ model: CourtCategory, as: 'category' }],
        order: [['category_id', 'ASC'], ['court_number', 'ASC']]
      });

      const selectedCourtId = req.query.court_id || (courts.length > 0 ? courts[0].id : null);
      const today = formatDate(new Date());
      const selectedDate = req.query.date || today;
      const initialSlot = req.query.slot || '08:00';

      res.render('pages/reservation', {
        title: 'Book a Court - 3KS Playground',
        courts,
        selectedCourtId: selectedCourtId ? parseInt(selectedCourtId, 10) : null,
        selectedDate,
        initialSlot,
        today,
        formatCurrency,
        formatTime12,
        user: req.session ? req.session.user : null,
        error: req.flash('error'),
        success: req.flash('success')
      });
    } catch (err) {
      next(err);
    }
  },

  async checkAvailability(req, res, next) {
    try {
      const { court_id, date, start_time, total_hours } = req.body;
      const hours = parseInt(total_hours, 10) || 1;
      const endTime = addHoursToTime(start_time, hours);

      const isAvailable = await isSlotRangeAvailable(court_id, date, start_time, endTime);
      return res.json({
        success: true,
        isAvailable,
        startTime: start_time,
        endTime,
        totalHours: hours
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  },

  async createReservation(req, res, next) {
    try {
      const {
        court_id,
        user_name,
        user_contact,
        user_email,
        reservation_date,
        start_time,
        total_hours,
        selected_slots,
        special_requests
      } = req.body;

      let slotsArray = [];
      let rawSlots = selected_slots;
      if (typeof rawSlots === 'string') {
        try {
          rawSlots = JSON.parse(rawSlots);
        } catch (e) {
          rawSlots = rawSlots.split(',').map(s => s.trim()).filter(Boolean);
        }
      }

      // Check if multi-court object structure: [{ courtId, startTime }, ...]
      const isObjectSlots = Array.isArray(rawSlots) && rawSlots.length > 0 && typeof rawSlots[0] === 'object' && rawSlots[0].startTime;

      if (isObjectSlots) {
        // Group by courtId
        const byCourt = {};
        rawSlots.forEach(item => {
          const cId = item.courtId || court_id;
          if (!byCourt[cId]) byCourt[cId] = [];
          byCourt[cId].push(item.startTime);
        });

        const courtIdKeys = Object.keys(byCourt);

        if (!user_name || !user_contact || !reservation_date || courtIdKeys.length === 0) {
          const errorMsg = 'Please select at least one time slot and fill in all required fields.';
          if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(400).json({ success: false, error: errorMsg });
          }
          req.flash('error', errorMsg);
          return res.redirect('/');
        }

        if (!isValidPhilippineMobile(user_contact)) {
          const errorMsg = 'Please provide a valid Philippine contact number (e.g., 09171234567).';
          if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(400).json({ success: false, error: errorMsg });
          }
          req.flash('error', errorMsg);
          return res.redirect('/');
        }

        if (user_email && !isValidEmail(user_email)) {
          const errorMsg = 'Please provide a valid email address.';
          if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(400).json({ success: false, error: errorMsg });
          }
          req.flash('error', errorMsg);
          return res.redirect('/');
        }

        // Validate availability on each court
        for (const cId of courtIdKeys) {
          const cSlots = byCourt[cId];
          const isAvail = await areSlotsAvailable(cId, reservation_date, cSlots);
          if (!isAvail) {
            const courtObj = await Court.findByPk(cId);
            const errorMsg = `Sorry, one or more selected slots on ${courtObj ? courtObj.display_name : 'court'} are no longer available. Please choose other available times.`;
            if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
              return res.status(409).json({ success: false, error: errorMsg });
            }
            req.flash('error', errorMsg);
            return res.redirect('/');
          }
        }

        const masterReference = generateReferenceNumber();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        const bindingCode = 'PLAY-' + Math.floor(1000 + Math.random() * 9000);

        let primaryReservation = null;
        let totalBookingAmount = 0;

        for (let i = 0; i < courtIdKeys.length; i++) {
          const cId = courtIdKeys[i];
          const cSlots = byCourt[cId].sort();
          const court = await Court.findByPk(cId, { include: [{ model: CourtCategory, as: 'category' }] });
          const hours = cSlots.length;
          const firstSlot = cSlots[0];
          const lastSlot = cSlots[cSlots.length - 1];
          const endTime = addHoursToTime(lastSlot, 1);
          const pricePerHour = parseFloat(court && court.category ? court.category.price_per_hour : 350);
          const totalAmount = pricePerHour * hours;
          totalBookingAmount += totalAmount;

          const refNum = i === 0 ? masterReference : `${masterReference}-${i + 1}`;

          const resv = await Reservation.create({
            reference_number: refNum,
            court_id: court.id,
            user_name: user_name.trim(),
            user_contact: user_contact.trim(),
            user_email: user_email ? user_email.trim().toLowerCase() : null,
            reservation_date,
            start_time: firstSlot,
            end_time: endTime,
            slots_json: JSON.stringify(cSlots),
            total_hours: hours,
            total_amount: totalAmount,
            status: 'AWAITING_PAYMENT',
            payment_provider: 'GCASH_QR',
            special_requests: special_requests ? special_requests.trim() : null,
            binding_code: bindingCode,
            expires_at: expiresAt
          });

          if (i === 0) {
            primaryReservation = resv;
          }

          await logAudit('RESERVATION_CREATED', {
            referenceNumber: refNum,
            court: court.display_name,
            date: reservation_date,
            time: `${firstSlot} - ${endTime}`,
            amount: totalAmount
          });

          try {
            const io = getIO();
            const availabilityData = await getCourtAvailability(court.id, reservation_date);
            io.emit('court_availability_updated', {
              courtId: court.id,
              date: reservation_date,
              slots: availabilityData.slots
            });
          } catch (sockErr) {}
        }

        // Each court preserves its individual accurate court total_amount (no double-counting)

        if (primaryReservation) {
          try {
            const { sendReservationCreatedNotification } = require('../services/facebookService');
            sendReservationCreatedNotification(primaryReservation).catch(() => {});
          } catch (e) {}

          if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.json({
              success: true,
              reference_number: primaryReservation.reference_number,
              redirect_url: `/payment/gcash?ref=${primaryReservation.reference_number}`
            });
          }

          return res.redirect(`/payment/gcash?ref=${primaryReservation.reference_number}`);
        }
      }

      slotsArray = Array.isArray(rawSlots) ? rawSlots : [];

      if (!slotsArray || slotsArray.length === 0) {
        if (start_time) {
          const hours = Math.min(Math.max(parseInt(total_hours, 10) || 1, 1), 8);
          for (let i = 0; i < hours; i++) {
            slotsArray.push(addHoursToTime(start_time, i));
          }
        }
      }

      if (!court_id || !user_name || !user_contact || !reservation_date || slotsArray.length === 0) {
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(400).json({ success: false, error: 'Please select at least one time slot and fill in all required fields.' });
        }
        req.flash('error', 'Please select at least one time slot and fill in all required fields.');
        return res.redirect('/reservations');
      }

      if (!isValidPhilippineMobile(user_contact)) {
        const errorMsg = 'Please provide a valid Philippine contact number (e.g., 09171234567).';
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(400).json({ success: false, error: errorMsg });
        }
        req.flash('error', errorMsg);
        return res.redirect(`/reservations?court_id=${court_id}&date=${reservation_date}`);
      }

      if (user_email && !isValidEmail(user_email)) {
        const errorMsg = 'Please provide a valid email address.';
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(400).json({ success: false, error: errorMsg });
        }
        req.flash('error', errorMsg);
        return res.redirect(`/reservations?court_id=${court_id}&date=${reservation_date}`);
      }

      const court = await Court.findByPk(court_id, {
        include: [{ model: CourtCategory, as: 'category' }]
      });

      if (!court || !court.is_active) {
        const errorMsg = 'Selected court is currently unavailable or under maintenance.';
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(400).json({ success: false, error: errorMsg });
        }
        req.flash('error', errorMsg);
        return res.redirect('/reservations');
      }

      // Check availability of all requested slots
      const isAvailable = await areSlotsAvailable(court_id, reservation_date, slotsArray);
      if (!isAvailable) {
        const errorMsg = 'Sorry, one or more selected time slots have already been booked. Please choose other available times.';
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(409).json({ success: false, error: errorMsg });
        }
        req.flash('error', errorMsg);
        return res.redirect(`/reservations?court_id=${court_id}&date=${reservation_date}`);
      }

      const hours = slotsArray.length;
      const firstSlot = slotsArray[0];
      const lastSlot = slotsArray[slotsArray.length - 1];
      const endTime = addHoursToTime(lastSlot, 1);

      const pricePerHour = parseFloat(court.category.price_per_hour);
      const totalAmount = pricePerHour * hours;
      const referenceNumber = generateReferenceNumber();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins validity

      const bindingCode = '3KS-' + Math.floor(1000 + Math.random() * 9000);

      const reservation = await Reservation.create({
        reference_number: referenceNumber,
        court_id: court.id,
        user_name: user_name.trim(),
        user_contact: user_contact.trim(),
        user_email: user_email ? user_email.trim().toLowerCase() : null,
        reservation_date,
        start_time: firstSlot,
        end_time: endTime,
        slots_json: JSON.stringify(slotsArray),
        total_hours: hours,
        total_amount: totalAmount,
        status: 'AWAITING_PAYMENT',
        payment_provider: 'GCASH_QR',
        special_requests: special_requests ? special_requests.trim() : null,
        binding_code: bindingCode,
        expires_at: expiresAt
      });

      await logAudit('RESERVATION_CREATED', {
        referenceNumber,
        court: court.display_name,
        date: reservation_date,
        time: `${start_time} - ${endTime}`,
        amount: totalAmount
      });

      try {
        const io = getIO();
        const availabilityData = await getCourtAvailability(court.id, reservation_date);
        io.emit('court_availability_updated', {
          courtId: court.id,
          date: reservation_date,
          slots: availabilityData.slots
        });
      } catch (e) {
        console.warn('Socket broadcast error:', e.message);
      }

      // Dispatch Facebook Messenger notification to Admin Profile (Async)
      try {
        const { notifyAdminNewBooking } = require('../services/facebookService');
        notifyAdminNewBooking(reservation).catch(e => console.warn('[FB Notify Error]:', e.message));
      } catch (e) {}

      const paymentIntent = await paymentService.createPaymentIntent(reservation);

      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({
          success: true,
          referenceNumber: reservation.reference_number,
          paymentUrl: paymentIntent.paymentUrl,
          expiresAt: reservation.expires_at
        });
      }

      res.redirect(paymentIntent.paymentUrl);
    } catch (err) {
      next(err);
    }
  },

  async getReservationByReference(req, res, next) {
    try {
      const { reference } = req.params;
      const reservation = await Reservation.findOne({
        where: { reference_number: reference },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }]
      });

      if (!reservation) {
        return res.status(404).render('pages/error', {
          title: 'Reservation Not Found',
          message: `No reservation found matching reference "${reference}".`,
          statusCode: 404,
          user: req.session ? req.session.user : null
        });
      }

      const masterRef = reference.split('-')[0];
      const siblingReservations = await Reservation.findAll({
        where: {
          reference_number: {
            [Op.or]: [
              masterRef,
              { [Op.like]: `${masterRef}-%` }
            ]
          }
        },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
        order: [['id', 'ASC']]
      });

      const totalOrderAmount = siblingReservations.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);

      res.render('pages/reservation-success', {
        title: `Booking Details - ${reservation.reference_number}`,
        reservation,
        siblingReservations,
        totalOrderAmount,
        formatCurrency,
        formatTime12,
        user: req.session ? req.session.user : null,
        hideNavbar: true
      });
    } catch (err) {
      next(err);
    }
  },

  async getReservationStatusJson(req, res, next) {
    try {
      const { reference } = req.params;
      const reservation = await Reservation.findOne({
        where: { reference_number: reference }
      });

      if (!reservation) {
        return res.status(404).json({ success: false, error: 'Reservation not found' });
      }

      res.json({
        success: true,
        reference: reservation.reference_number,
        status: reservation.status,
        expiresAt: reservation.expires_at,
        isExpired: reservation.status === 'EXPIRED' || (new Date() > new Date(reservation.expires_at) && reservation.status === 'AWAITING_PAYMENT')
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  showLookupPage(req, res) {
    res.render('pages/lookup', {
      title: 'Find My Reservation - The Playground Pickleball',
      user: req.session ? req.session.user : null,
      error: req.flash('error'),
      hideNavbar: true
    });
  }
};

module.exports = reservationController;
