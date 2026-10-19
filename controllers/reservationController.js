const { Reservation, Court, CourtCategory, User } = require('../models');
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
      if (!req.session || !req.session.user) {
        req.flash('error', 'Please sign in or create a Player Account to book a court.');
        return res.redirect('/account/login?returnTo=' + encodeURIComponent(req.originalUrl || '/reservations'));
      }

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
        title: 'Book a Court - The Playground Pickleball',
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
      // Strictly disallow guest bookings — user must be signed in
      if (!req.session || !req.session.user) {
        const authErr = 'Guest booking is disabled. Please sign in or create a Player Account to book a court.';
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(401).json({ success: false, requiresAuth: true, error: authErr });
        }
        req.flash('error', authErr);
        return res.redirect('/account/login?returnTo=/');
      }

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
        const dbUser = (req.session && req.session.user) ? await User.findByPk(req.session.user.id) : null;
        const bindingCode = (dbUser && dbUser.binding_code) ? dbUser.binding_code : ('PLAY-' + Math.floor(1000 + Math.random() * 9000));
        const accountPsid = dbUser && dbUser.fb_psid ? dbUser.fb_psid : null;

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

          const refNum = masterReference;

          const resv = await Reservation.create({
            reference_number: refNum,
            court_id: court.id,
            user_id: req.session && req.session.user ? req.session.user.id : null,
            user_name: (user_name || (req.session?.user?.full_name) || '').trim(),
            user_contact: (user_contact || (req.session?.user?.phone) || '').trim(),
            user_email: (user_email || (req.session?.user?.email) || '') ? (user_email || req.session?.user?.email).trim().toLowerCase() : null,
            reservation_date,
            start_time: firstSlot,
            end_time: endTime,
            slots_json: JSON.stringify(cSlots),
            total_hours: hours,
            total_amount: totalAmount,
            status: 'AWAITING_PAYMENT',
            payment_provider: 'GCASH_QR',
            special_requests: special_requests ? special_requests.trim() : null,
            fb_psid: accountPsid,
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
          const courtSummary = courtIdKeys.length > 1 ? `${courtIdKeys.length} Courts` : `Court ${primaryReservation.court_id}`;
          try {
            const { postBookingSystemMessage } = require('../services/chatService');
            postBookingSystemMessage(primaryReservation, 'BOOKING_CREATED', {
              courtSummary,
              totalAmount: totalBookingAmount
            }).catch(() => {});
          } catch (e) {}

          try {
            const { notifyAdminNewBooking, notifyPlayerNewBooking } = require('../services/facebookService');
            notifyAdminNewBooking(primaryReservation, { courtSummary, totalAmount: totalBookingAmount }).catch(() => {});
            notifyPlayerNewBooking(primaryReservation, { courtSummary, totalAmount: totalBookingAmount }).catch(() => {});
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

      const dbUser = (req.session && req.session.user) ? await User.findByPk(req.session.user.id) : null;
      const bindingCode = (dbUser && dbUser.binding_code) ? dbUser.binding_code : ('PLAY-' + Math.floor(1000 + Math.random() * 9000));
      const accountPsid = dbUser && dbUser.fb_psid ? dbUser.fb_psid : null;

      const reservation = await Reservation.create({
        reference_number: referenceNumber,
        court_id: court.id,
        user_id: req.session && req.session.user ? req.session.user.id : null,
        user_name: (user_name || (req.session?.user?.full_name) || '').trim(),
        user_contact: (user_contact || (req.session?.user?.phone) || '').trim(),
        user_email: (user_email || (req.session?.user?.email) || '') ? (user_email || req.session?.user?.email).trim().toLowerCase() : null,
        reservation_date,
        start_time: firstSlot,
        end_time: endTime,
        slots_json: JSON.stringify(slotsArray),
        total_hours: hours,
        total_amount: totalAmount,
        status: 'AWAITING_PAYMENT',
        payment_provider: 'GCASH_QR',
        special_requests: special_requests ? special_requests.trim() : null,
        fb_psid: accountPsid,
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

      // Post Booking Card to Player's In-App Account Chat
      try {
        const { postBookingSystemMessage } = require('../services/chatService');
        postBookingSystemMessage(reservation, 'BOOKING_CREATED', {
          courtSummary: court.display_name,
          totalAmount
        }).catch(() => {});
      } catch (e) {}

      // Dispatch Facebook Messenger notification to Admin & Player Profiles (Async)
      try {
        const { notifyAdminNewBooking, notifyPlayerNewBooking } = require('../services/facebookService');
        notifyAdminNewBooking(reservation, { courtSummary: court.display_name, totalAmount }).catch(e => console.warn('[FB Notify Error]:', e.message));
        notifyPlayerNewBooking(reservation, { courtSummary: court.display_name, totalAmount }).catch(e => console.warn('[FB Player Notify Error]:', e.message));
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
      const cleanQuery = reference.trim();
      const reservation = await Reservation.findOne({
        where: {
          [Op.or]: [
            { reference_number: cleanQuery },
            { user_contact: cleanQuery }
          ]
        },
        include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
        order: [['id', 'DESC']]
      });

      if (!reservation) {
        return res.status(404).render('pages/error', {
          title: 'Reservation Not Found',
          message: `No reservation found matching reference or contact number "${reference}".`,
          statusCode: 404,
          user: req.session ? req.session.user : null
        });
      }

      const masterRef = reservation.reference_number.split('-')[0];
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
      const cleanQuery = reference.trim();
      const reservation = await Reservation.findOne({
        where: {
          [Op.or]: [
            { reference_number: cleanQuery },
            { user_contact: cleanQuery }
          ]
        },
        order: [['id', 'DESC']]
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

  async getPlayerReservationsGrouped(sessionUser) {
    if (!sessionUser) return [];

    const matchConditions = [{ user_id: sessionUser.id }];
    if (sessionUser.phone) {
      matchConditions.push({ user_contact: sessionUser.phone });
    }
    if (sessionUser.email) {
      matchConditions.push({ user_email: sessionUser.email.toLowerCase() });
    }

    const rawReservations = await Reservation.findAll({
      where: { [Op.or]: matchConditions },
      include: [{ model: Court, as: 'court', include: [{ model: CourtCategory, as: 'category' }] }],
      order: [['created_at', 'DESC'], ['id', 'ASC']]
    });

    // Group multi-court orders by master reference number
    const groupedMap = new Map();
    for (const r of rawReservations) {
      const masterRef = r.reference_number;
      if (!groupedMap.has(masterRef)) {
        let parsedSlots = [];
        try {
          parsedSlots = r.slots_json ? JSON.parse(r.slots_json) : [r.start_time];
        } catch (e) {
          parsedSlots = [r.start_time];
        }
        groupedMap.set(masterRef, {
          reference_number: masterRef,
          reservation_date: r.reservation_date,
          status: r.status,
          expires_at: r.expires_at,
          created_at: r.created_at,
          user_name: r.user_name,
          user_contact: r.user_contact,
          user_email: r.user_email,
          gcash_reference_no: r.gcash_reference_no || null,
          payment_screenshot: r.payment_screenshot || null,
          payment_transaction_id: r.payment_transaction_id || null,
          cancellation_reason: r.cancellation_reason || null,
          total_amount: parseFloat(r.total_amount || 0),
          total_hours: parseInt(r.total_hours || 1, 10),
          courts: [
            {
              court_name: r.court ? r.court.display_name : `Court ${r.court_id}`,
              start_time: r.start_time,
              end_time: r.end_time,
              hours: parseInt(r.total_hours || 1, 10),
              amount: parseFloat(r.total_amount || 0),
              slots: parsedSlots
            }
          ]
        });
      } else {
        const entry = groupedMap.get(masterRef);
        entry.total_amount += parseFloat(r.total_amount || 0);
        entry.total_hours += parseInt(r.total_hours || 1, 10);
        if (!entry.gcash_reference_no && r.gcash_reference_no) entry.gcash_reference_no = r.gcash_reference_no;
        if (!entry.payment_screenshot && r.payment_screenshot) entry.payment_screenshot = r.payment_screenshot;
        if (!entry.payment_transaction_id && r.payment_transaction_id) entry.payment_transaction_id = r.payment_transaction_id;
        let parsedSlots = [];
        try {
          parsedSlots = r.slots_json ? JSON.parse(r.slots_json) : [r.start_time];
        } catch (e) {
          parsedSlots = [r.start_time];
        }
        entry.courts.push({
          court_name: r.court ? r.court.display_name : `Court ${r.court_id}`,
          start_time: r.start_time,
          end_time: r.end_time,
          hours: parseInt(r.total_hours || 1, 10),
          amount: parseFloat(r.total_amount || 0),
          slots: parsedSlots
        });
      }
    }

    return Array.from(groupedMap.values());
  },

  async getMyBookingsJson(req, res, next) {
    try {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, requiresAuth: true, error: 'Not logged in.' });
      }
      const dbUser = await User.findByPk(req.session.user.id);
      if (dbUser) {
        if (!dbUser.binding_code) {
          dbUser.binding_code = 'PLAY-' + Math.floor(1000 + Math.random() * 9000);
          await dbUser.save();
        }
        req.session.user.fb_psid = dbUser.fb_psid || null;
        req.session.user.binding_code = dbUser.binding_code;
      }
      const bookings = await reservationController.getPlayerReservationsGrouped(req.session.user);
      res.json({
        success: true,
        user: req.session.user,
        bookings
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
