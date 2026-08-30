const { User } = require('../models');
const { logAudit } = require('../utils/helpers');

const authController = {
  showLogin(req, res) {
    res.render('admin/login', {
      title: 'Admin Login - PicklePlay Pro',
      layout: 'layouts/auth',
      error: req.flash('error'),
      success: req.flash('success')
    });
  },

  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        req.flash('error', 'Username and password are required.');
        return res.redirect('/admin/login');
      }

      const user = await User.findOne({ where: { username } });
      if (!user) {
        req.flash('error', 'Invalid username or password.');
        return res.redirect('/admin/login');
      }

      const isMatch = await user.validPassword(password);
      if (!isMatch) {
        req.flash('error', 'Invalid username or password.');
        return res.redirect('/admin/login');
      }

      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };

      await logAudit('ADMIN_LOGIN', { username: user.username }, user.id);
      req.flash('success', `Welcome back, ${user.username}!`);
      res.redirect('/admin');
    } catch (err) {
      next(err);
    }
  },

  async logout(req, res, next) {
    try {
      if (req.session && req.session.user) {
        await logAudit('ADMIN_LOGOUT', { username: req.session.user.username }, req.session.user.id);
      }
      req.session.destroy(() => {
        res.redirect('/admin/login');
      });
    } catch (err) {
      next(err);
    }
  }
};

module.exports = authController;
