const { CourtCategory, Court, Reservation } = require('../models');
const { getCourtAvailability } = require('../services/availabilityService');
const { formatDate } = require('../utils/dateTimeUtils');

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
      const availability = await getCourtAvailability(court.id, selectedDate);

      res.render('pages/court-detail', {
        title: `${court.display_name} - PicklePlay Pro`,
        court,
        selectedDate,
        availability,
        today,
        user: req.session ? req.session.user : null
      });
    } catch (err) {
      next(err);
    }
  },

  async getCourtAvailabilityJson(req, res, next) {
    try {
      const courtId = req.params.id;
      const date = req.query.date || formatDate(new Date());
      const data = await getCourtAvailability(courtId, date);
      res.json({ success: true, data });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
};

module.exports = courtController;
