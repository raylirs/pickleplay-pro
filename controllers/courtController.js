const { CourtCategory, Court, Reservation, CourtBlock } = require('../models');
const { getCourtAvailability, getFacilityClosedDates } = require('../services/availabilityService');
const { formatDate } = require('../utils/dateTimeUtils');
const { Op } = require('sequelize');

const courtController = {
  async getPublicCourts(req, res, next) {
    try {
      const categories = await CourtCategory.findAll({
        include: [{ model: Court, as: 'courts' }],
        order: [['id', 'ASC']]
      });

      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({ success: true, categories });
      }

      res.render('pages/courts', {
        title: 'Our Courts - PicklePlay Pro',
        categories,
        user: req.session ? req.session.user : null
      });
    } catch (err) {
      next(err);
    }
  },

  async getCourtDetail(req, res, next) {
    try {
      const courtId = req.params.id;
      const court = await Court.findByPk(courtId, {
        include: [{ model: CourtCategory, as: 'category' }]
      });

      if (!court) {
        return res.status(404).render('pages/error', {
          title: 'Court Not Found',
          message: 'The requested court does not exist.',
          statusCode: 404,
          user: req.session ? req.session.user : null
        });
      }

      const today = formatDate(new Date());
      const selectedDate = req.query.date || today;
      const currentUser = req.session ? req.session.user : null;
      const availability = await getCourtAvailability(court.id, selectedDate, currentUser);

      res.render('pages/court-detail', {
        title: `${court.display_name} - The Playground Pickleball`,
        court,
        selectedDate,
        availability,
        today,
        user: currentUser
      });
    } catch (err) {
      next(err);
    }
  },

  async getCourtAvailabilityJson(req, res, next) {
    try {
      const courtId = req.params.id;
      const date = req.query.date || formatDate(new Date());
      const currentUser = req.session ? req.session.user : null;
      const data = await getCourtAvailability(courtId, date, currentUser);
      res.json({ success: true, data });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  },

  async getAllCourtsAvailabilityJson(req, res, next) {
    try {
      const date = req.query.date || formatDate(new Date());
      const currentUser = req.session ? req.session.user : null;
      const courts = await Court.findAll({
        where: { is_active: true },
        include: [{ model: CourtCategory, as: 'category' }],
        order: [['court_number', 'ASC'], ['id', 'ASC']]
      });

      const availabilityPromises = courts.map(async (c) => {
        const avail = await getCourtAvailability(c.id, date, currentUser);
        return {
          id: c.id,
          name: c.display_name,
          courtNumber: c.court_number,
          pricePerHour: c.category ? parseFloat(c.category.price_per_hour) : 350,
          categoryName: c.category ? c.category.name : 'Championship Court',
          slots: avail.slots
        };
      });

      const [courtsData, closedDates] = await Promise.all([
        Promise.all(availabilityPromises),
        getFacilityClosedDates()
      ]);

      const isDayClosed = Boolean(closedDates[date]);
      const closedReason = closedDates[date] || null;

      res.json({
        success: true,
        date,
        isDayClosed,
        closedReason,
        closedDates,
        courts: courtsData
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  },

  async getCalendarMonthStatusJson(req, res, next) {
    try {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1); // 1-12
      const monthStr = String(month).padStart(2, '0');
      const startDate = `${year}-${monthStr}-01`;
      const daysInMonth = new Date(year, month, 0).getDate();
      const endDate = `${year}-${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
      const currentUser = req.session ? req.session.user : null;

      // 1. Get active courts and define daily operating slots
      const courts = await Court.findAll({
        where: { is_active: true },
        attributes: ['id', 'display_name']
      });

      const operatingSlots = [
        '06:00', '07:00', '08:00', '09:00', '10:00', '11:00',
        '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
        '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'
      ];
      const slotsPerDayPerCourt = operatingSlots.length; // 18
      const totalCourtSlotsPerDay = (courts.length || 4) * slotsPerDayPerCourt; // e.g. 72

      // 2. Fetch court blocks for the month
      const blocks = await CourtBlock.findAll({
        where: {
          date: { [Op.between]: [startDate, endDate] }
        }
      });

      // 3. Fetch active reservations for the month
      const reservations = await Reservation.findAll({
        where: {
          reservation_date: { [Op.between]: [startDate, endDate] },
          status: { [Op.in]: ['CONFIRMED', 'AWAITING_PAYMENT', 'AWAITING_CONFIRMATION', 'PENDING'] }
        },
        attributes: ['id', 'reference_number', 'court_id', 'reservation_date', 'start_time', 'end_time', 'slots_json', 'status', 'user_id', 'user_contact', 'user_email']
      });

      // Helper to check if a reservation belongs to currentUser
      const isUserReservation = (r) => {
        if (!currentUser) return false;
        if (currentUser.id && r.user_id && Number(currentUser.id) === Number(r.user_id)) return true;
        if (currentUser.phone && r.user_contact && r.user_contact === currentUser.phone) return true;
        if (currentUser.email && r.user_email && currentUser.email.toLowerCase() === r.user_email.toLowerCase()) return true;
        return false;
      };

      // Helper to parse slots from an object (block or reservation)
      const extractSlots = (item) => {
        if (item.slots_json) {
          try {
            const arr = JSON.parse(item.slots_json);
            if (Array.isArray(arr) && arr.length > 0) return arr;
          } catch(e) {}
        }
        const startH = parseInt((item.start_time || '06:00').split(':')[0], 10);
        const endH = parseInt((item.end_time || '24:00').split(':')[0], 10);
        const sArr = [];
        for (let h = startH; h < endH; h++) {
          const hh = String(h).padStart(2, '0') + ':00';
          if (operatingSlots.includes(hh)) sArr.push(hh);
        }
        return sArr;
      };

      // 4. Compute status for each day of the month
      const daysStatus = {};

      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
        const dayBlocks = blocks.filter(b => b.date === dateStr);
        const dayReservations = reservations.filter(r => r.reservation_date === dateStr);

        // Check user booking hint
        const userResForDay = dayReservations.filter(isUserReservation);
        const hasUserBooking = userResForDay.length > 0;
        const userBookingRefs = [...new Set(userResForDay.map(r => r.reference_number))];

        // Check if day has any Open Play block
        const openPlayBlock = dayBlocks.find(b => b.reason && /open\s*play/i.test(b.reason));
        const isOpenPlayDay = Boolean(openPlayBlock);

        // Check full-day facility block (all courts all day)
        const fullDayClosure = dayBlocks.find(b => b.is_all_day && (b.all_courts || !b.court_id));
        if (fullDayClosure) {
          const isFullDayOpenPlay = /open\s*play/i.test(fullDayClosure.reason || '');
          daysStatus[dateStr] = {
            status: isFullDayOpenPlay ? 'OPEN_PLAY' : 'BLOCKED',
            label: isFullDayOpenPlay ? 'Open Play' : 'Blocked',
            reason: fullDayClosure.reason || (isFullDayOpenPlay ? 'Open Play (Walk-ins & Drop-ins Welcome)' : 'Court Maintenance / Blocked'),
            availableSlots: 0,
            totalSlots: totalCourtSlotsPerDay,
            hasUserBooking,
            userBookingRefs,
            isOpenPlay: isFullDayOpenPlay
          };
          continue;
        }

        // Count occupied slots per court
        let occupiedSlotsCount = 0;

        for (const court of courts) {
          const courtOccupiedSlots = new Set();

          // Blocks affecting this court
          const relevantBlocks = dayBlocks.filter(b => b.all_courts || !b.court_id || Number(b.court_id) === Number(court.id));
          for (const b of relevantBlocks) {
            if (b.is_all_day) {
              operatingSlots.forEach(s => courtOccupiedSlots.add(s));
            } else {
              extractSlots(b).forEach(s => courtOccupiedSlots.add(s));
            }
          }

          // Reservations on this court
          const relevantRes = dayReservations.filter(r => Number(r.court_id) === Number(court.id));
          for (const r of relevantRes) {
            extractSlots(r).forEach(s => courtOccupiedSlots.add(s));
          }

          occupiedSlotsCount += Math.min(courtOccupiedSlots.size, slotsPerDayPerCourt);
        }

        const availableSlots = Math.max(0, totalCourtSlotsPerDay - occupiedSlotsCount);

        let dayStatus = 'AVAILABLE';
        let label = 'Available';

        if (availableSlots <= 0) {
          const hasBlocks = dayBlocks.length > 0;
          if (isOpenPlayDay) {
            dayStatus = 'OPEN_PLAY';
            label = 'Open Play';
          } else {
            dayStatus = hasBlocks ? 'BLOCKED' : 'FULL';
            label = hasBlocks ? 'Blocked' : 'Fully Booked';
          }
        } else if (isOpenPlayDay) {
          dayStatus = 'OPEN_PLAY';
          label = 'Open Play';
        } else if (availableSlots <= 5) {
          dayStatus = 'FEW_LEFT';
          label = `${availableSlots} Slots Left`;
        }

        daysStatus[dateStr] = {
          status: dayStatus,
          label,
          availableSlots,
          totalSlots: totalCourtSlotsPerDay,
          hasUserBooking,
          userBookingRefs,
          isOpenPlay: isOpenPlayDay,
          reason: openPlayBlock ? openPlayBlock.reason : null
        };
      }

      res.json({
        success: true,
        year,
        month,
        days: daysStatus
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
};

module.exports = courtController;
