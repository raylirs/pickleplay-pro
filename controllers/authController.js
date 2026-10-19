const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User, Reservation } = require('../models');
const { logAudit } = require('../utils/helpers');
const { isValidPhilippineMobile, isValidEmail } = require('../utils/validators');

function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s-]/g, '');
  if (cleaned.startsWith('+639') && cleaned.length === 13) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('639') && cleaned.length === 12) {
    cleaned = '0' + cleaned.slice(2);
  }
  return cleaned;
}

function generateAccountBindingCode() {
  return 'PLAY-' + Math.floor(1000 + Math.random() * 9000);
}

async function ensureUserBindingCode(user) {
  if (!user.binding_code) {
    user.binding_code = generateAccountBindingCode();
    await user.save();
  }
  return user.binding_code;
}

async function linkExistingReservationsToUser(user) {
  try {
    await ensureUserBindingCode(user);

    const conditions = [{ user_id: user.id }];
    if (user.phone) {
      conditions.push({ user_contact: user.phone });
    }
    if (user.email) {
      conditions.push({ user_email: user.email.toLowerCase() });
    }

    // Link unlinked reservations to this user
    await Reservation.update(
      { user_id: user.id },
      {
        where: {
          user_id: null,
          [Op.or]: conditions
        }
      }
    );

    // If user doesn't have fb_psid yet, check if any of their reservations already bound Messenger
    if (!user.fb_psid) {
      const boundResv = await Reservation.findOne({
        where: {
          user_id: user.id,
          fb_psid: { [Op.ne]: null }
        },
        order: [['updated_at', 'DESC']]
      });
      if (boundResv && boundResv.fb_psid) {
        user.fb_psid = boundResv.fb_psid;
        await user.save();
      }
    }

    // If user has fb_psid, ensure all their reservations have it
    if (user.fb_psid) {
      await Reservation.update(
        { fb_psid: user.fb_psid },
        {
          where: {
            user_id: user.id,
            fb_psid: null
          }
        }
      );
    }
  } catch (err) {
    console.warn('[Auth] Could not link existing reservations:', err.message);
  }
}

const authController = {
  // =========================================================
  // ADMIN AUTHENTICATION
  // =========================================================
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

      const cleanId = username.trim().toLowerCase();
      const normalizedMobile = normalizePhone(username.trim());

      const user = await User.findOne({
        where: {
          [Op.or]: [
            { username: cleanId },
            { email: cleanId },
            ...(normalizedMobile ? [{ phone: normalizedMobile }] : [])
          ]
        }
      });

      if (!user) {
        req.flash('error', 'Invalid username or password.');
        return res.redirect('/admin/login');
      }

      const isMatch = await user.validPassword(password);
      if (!isMatch) {
        req.flash('error', 'Invalid username or password.');
        return res.redirect('/admin/login');
      }

      await linkExistingReservationsToUser(user);

      req.session.user = {
        id: user.id,
        username: user.username,
        full_name: user.full_name || user.username,
        email: user.email || '',
        phone: user.phone || '',
        fb_psid: user.fb_psid || null,
        binding_code: user.binding_code,
        role: user.role
      };

      await logAudit('ADMIN_LOGIN', { username: user.username }, user.id);

      if (user.role === 'admin' || user.role === 'staff') {
        req.flash('success', `Welcome back, ${user.full_name || user.username}!`);
        return res.redirect('/admin');
      }

      req.flash('success', `Welcome back, ${user.full_name || user.username}!`);
      return res.redirect('/');
    } catch (err) {
      next(err);
    }
  },

  async logout(req, res, next) {
    try {
      const wasAdmin = req.session?.user?.role === 'admin' || req.session?.user?.role === 'staff';
      if (req.session && req.session.user) {
        await logAudit('USER_LOGOUT', { username: req.session.user.username }, req.session.user.id);
      }
      req.session.destroy(() => {
        res.redirect(wasAdmin ? '/admin/login' : '/');
      });
    } catch (err) {
      next(err);
    }
  },

  // =========================================================
  // PLAYER ACCOUNT AUTHENTICATION (Email or Phone + Password)
  // =========================================================
  showPlayerLogin(req, res) {
    if (req.session && req.session.user) {
      return res.redirect('/');
    }
    res.render('pages/player-auth', {
      title: 'Player Sign In - The Playground Pickleball',
      mode: 'login',
      error: req.flash('error'),
      success: req.flash('success'),
      hideNavbar: true
    });
  },

  showPlayerRegister(req, res) {
    if (req.session && req.session.user) {
      return res.redirect('/');
    }
    res.render('pages/player-auth', {
      title: 'Create Player Account - The Playground Pickleball',
      mode: 'register',
      error: req.flash('error'),
      success: req.flash('success'),
      hideNavbar: true
    });
  },

  async playerLogin(req, res, next) {
    try {
      const { identifier, password } = req.body;
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');

      if (!identifier || !password) {
        const msg = 'Please enter your email or mobile number and password.';
        if (isAjax) return res.status(400).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/login');
      }

      const rawId = identifier.trim();
      const lowerId = rawId.toLowerCase();
      const normalizedMobile = normalizePhone(rawId);

      const orConditions = [
        { username: lowerId },
        { email: lowerId }
      ];
      if (normalizedMobile) {
        orConditions.push({ phone: normalizedMobile });
        orConditions.push({ username: normalizedMobile });
      }

      const user = await User.findOne({
        where: { [Op.or]: orConditions }
      });

      if (!user) {
        const msg = 'No account found with that email or mobile number.';
        if (isAjax) return res.status(401).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/login');
      }

      const isMatch = await user.validPassword(password);
      if (!isMatch) {
        const msg = 'Incorrect password. Please try again.';
        if (isAjax) return res.status(401).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/login');
      }

      await linkExistingReservationsToUser(user);

      const sessionUser = {
        id: user.id,
        username: user.username,
        full_name: user.full_name || user.username,
        email: user.email || '',
        phone: user.phone || '',
        fb_psid: user.fb_psid || null,
        binding_code: user.binding_code,
        role: user.role
      };
      req.session.user = sessionUser;
      req.session.lastActiveAt = Date.now();

      await logAudit('PLAYER_LOGIN', { username: user.username, phone: user.phone }, user.id);

      return req.session.save(() => {
        if (isAjax) {
          return res.json({
            success: true,
            user: sessionUser,
            message: `Welcome back, ${sessionUser.full_name}!`
          });
        }

        const returnTo = req.query.returnTo || req.body.returnTo || '/';
        req.flash('success', `Welcome back, ${sessionUser.full_name}!`);
        res.redirect(returnTo);
      });
    } catch (err) {
      next(err);
    }
  },

  async playerRegister(req, res, next) {
    try {
      const { full_name, phone, email, password, confirm_password } = req.body;
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');

      const sendError = (msg, status = 400) => {
        if (isAjax) return res.status(status).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/register');
      };

      if (!full_name || !phone || !password) {
        return sendError('Full Name, GCash Mobile Number, and Password are required.');
      }

      const cleanName = full_name.trim();
      const cleanPhone = normalizePhone(phone);
      const cleanEmail = email ? email.trim().toLowerCase() : null;

      if (!isValidPhilippineMobile(cleanPhone)) {
        return sendError('Please enter a valid Philippine mobile number (e.g. 09171234567).');
      }

      if (cleanEmail && !isValidEmail(cleanEmail)) {
        return sendError('Please enter a valid email address.');
      }

      if (password.length < 6) {
        return sendError('Password must be at least 6 characters long.');
      }

      if (confirm_password !== undefined && password !== confirm_password) {
        return sendError('Passwords do not match.');
      }

      // Check if phone or email is already registered
      const duplicateChecks = [{ phone: cleanPhone }, { username: cleanPhone }];
      if (cleanEmail) {
        duplicateChecks.push({ email: cleanEmail });
        duplicateChecks.push({ username: cleanEmail });
      }

      const existingUser = await User.findOne({
        where: { [Op.or]: duplicateChecks }
      });

      if (existingUser) {
        return sendError('An account with that mobile number or email already exists. Please sign in instead.', 409);
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const generatedUsername = cleanEmail || cleanPhone;

      const newUser = await User.create({
        username: generatedUsername,
        full_name: cleanName,
        phone: cleanPhone,
        email: cleanEmail,
        binding_code: generateAccountBindingCode(),
        password_hash: passwordHash,
        role: 'player'
      });

      await linkExistingReservationsToUser(newUser);

      const sessionUser = {
        id: newUser.id,
        username: newUser.username,
        full_name: newUser.full_name,
        email: newUser.email || '',
        phone: newUser.phone || '',
        fb_psid: newUser.fb_psid || null,
        binding_code: newUser.binding_code,
        role: newUser.role
      };
      req.session.user = sessionUser;
      req.session.lastActiveAt = Date.now();

      await logAudit('PLAYER_REGISTERED', { full_name: cleanName, phone: cleanPhone, email: cleanEmail }, newUser.id);

      return req.session.save(() => {
        if (isAjax) {
          return res.json({
            success: true,
            user: sessionUser,
            message: `Account created! Welcome to The Playground, ${cleanName}!`
          });
        }

        req.flash('success', `Account created! Welcome to The Playground, ${cleanName}!`);
        res.redirect('/');
      });
    } catch (err) {
      next(err);
    }
  },

  async playerLogout(req, res, next) {
    try {
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');
      const isTimeout = req.query.timeout === '1';
      if (req.session && req.session.user) {
        await logAudit(isTimeout ? 'PLAYER_SESSION_TIMEOUT' : 'PLAYER_LOGOUT', { username: req.session.user.username }, req.session.user.id);
      }
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        if (isAjax) {
          return res.json({ success: true, timedOut: isTimeout });
        }
        res.redirect('/');
      });
    } catch (err) {
      next(err);
    }
  }
};

module.exports = authController;

