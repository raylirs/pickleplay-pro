const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User, Reservation } = require('../models');
const { logAudit } = require('../utils/helpers');
const { isValidPhilippineMobile, isValidEmail } = require('../utils/validators');
const { sendEmailVerificationOTP, sendPasswordResetOTP } = require('../services/emailService');

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local.slice(0, 2)}${'*'.repeat(Math.min(local.length - 2, 5))}@${domain}`;
}

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
  // PLAYER ACCOUNT AUTHENTICATION (Email OTP + Password Recovery)
  // =========================================================
  showPlayerLogin(req, res) {
    if (req.session && req.session.user) {
      return res.redirect('/');
    }
    res.render('pages/player-auth', {
      title: 'Player Sign In - The Playground Pickleball',
      mode: req.query.mode || 'login',
      verifyEmail: req.query.email || '',
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
      verifyEmail: '',
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

      // Check if player account requires email OTP verification
      if (user.role === 'player' && !user.email_verified) {
        if (user.email) {
          const otpCode = generateOtpCode();
          user.otp_code = otpCode;
          user.otp_expires_at = new Date(Date.now() + OTP_EXPIRY_MS);
          user.otp_purpose = 'VERIFY_EMAIL';
          await user.save();

          const emailRes = await sendEmailVerificationOTP(user.email, user.full_name, otpCode);
          const verifyMsg = `Please confirm your email address. We sent a 6-digit OTP to ${user.email}.`;

          if (isAjax) {
            return res.json({
              success: false,
              requires_verification: true,
              user_id: user.id,
              email: user.email,
              mocked_otp: emailRes.mocked ? otpCode : undefined,
              message: verifyMsg
            });
          }
          req.flash('success', verifyMsg);
          return res.redirect(`/account/login?mode=verify&email=${encodeURIComponent(user.email)}`);
        } else {
          // Legacy account without email yet — ask user to enter email to receive OTP
          const setupMsg = 'Please enter your email address to receive a verification OTP and enable password recovery.';
          if (isAjax) {
            return res.json({
              success: false,
              requires_verification: true,
              requires_email_input: true,
              user_id: user.id,
              email: '',
              message: setupMsg
            });
          }
          req.flash('error', setupMsg);
          return res.redirect('/account/login?mode=verify');
        }
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
        email_verified: !!user.email_verified,
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

      if (!full_name || !phone || !email || !password) {
        return sendError('Full Name, GCash Mobile Number, Email Address, and Password are required.');
      }

      const cleanName = full_name.trim();
      const cleanPhone = normalizePhone(phone);
      const cleanEmail = email.trim().toLowerCase();

      if (!isValidPhilippineMobile(cleanPhone)) {
        return sendError('Please enter a valid Philippine mobile number (e.g. 09171234567).');
      }

      if (!isValidEmail(cleanEmail)) {
        return sendError('Please enter a valid email address so we can send your confirmation OTP.');
      }

      if (password.length < 6) {
        return sendError('Password must be at least 6 characters long.');
      }

      if (confirm_password !== undefined && password !== confirm_password) {
        return sendError('Passwords do not match.');
      }

      // Check if phone or email is already registered
      const duplicateChecks = [
        { phone: cleanPhone },
        { username: cleanPhone },
        { email: cleanEmail },
        { username: cleanEmail }
      ];

      const existingUsers = await User.findAll({
        where: { [Op.or]: duplicateChecks }
      });

      const verifiedDuplicate = existingUsers.find(u => u.email_verified);
      if (verifiedDuplicate) {
        return sendError('An account with that mobile number or email already exists. Please sign in instead.', 409);
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const otpCode = generateOtpCode();
      const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

      let targetUser = existingUsers[0] || null;
      if (targetUser) {
        // Update unverified registration record and resend fresh OTP
        targetUser.username = cleanEmail;
        targetUser.full_name = cleanName;
        targetUser.phone = cleanPhone;
        targetUser.email = cleanEmail;
        targetUser.password_hash = passwordHash;
        targetUser.email_verified = false;
        targetUser.otp_code = otpCode;
        targetUser.otp_expires_at = otpExpiresAt;
        targetUser.otp_purpose = 'VERIFY_EMAIL';
        if (!targetUser.binding_code) {
          targetUser.binding_code = generateAccountBindingCode();
        }
        await targetUser.save();
      } else {
        targetUser = await User.create({
          username: cleanEmail,
          full_name: cleanName,
          phone: cleanPhone,
          email: cleanEmail,
          binding_code: generateAccountBindingCode(),
          password_hash: passwordHash,
          role: 'player',
          email_verified: false,
          otp_code: otpCode,
          otp_expires_at: otpExpiresAt,
          otp_purpose: 'VERIFY_EMAIL'
        });
      }

      const emailRes = await sendEmailVerificationOTP(cleanEmail, cleanName, otpCode);
      await logAudit('PLAYER_OTP_SENT', { full_name: cleanName, phone: cleanPhone, email: cleanEmail, purpose: 'VERIFY_EMAIL' }, targetUser.id);

      const verifyMessage = `We sent a 6-digit confirmation OTP to ${cleanEmail}. Please enter it below to activate your account.`;

      if (isAjax) {
        return res.json({
          success: true,
          requires_verification: true,
          user_id: targetUser.id,
          email: cleanEmail,
          mocked_otp: emailRes.mocked ? otpCode : undefined,
          message: verifyMessage
        });
      }

      req.flash('success', verifyMessage);
      return res.redirect(`/account/login?mode=verify&email=${encodeURIComponent(cleanEmail)}`);
    } catch (err) {
      next(err);
    }
  },

  async verifyEmailOtp(req, res, next) {
    try {
      const { email, user_id, otp_code } = req.body;
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');

      const sendError = (msg, status = 400) => {
        if (isAjax) return res.status(status).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect(`/account/login?mode=verify&email=${encodeURIComponent(email || '')}`);
      };

      if (!otp_code || !String(otp_code).trim()) {
        return sendError('Please enter the 6-digit OTP code sent to your email.');
      }

      const cleanOtp = String(otp_code).trim();
      const cleanEmail = email ? email.trim().toLowerCase() : '';

      let user = null;
      if (user_id) {
        user = await User.findByPk(user_id);
      }
      if (!user && cleanEmail) {
        user = await User.findOne({
          where: {
            [Op.or]: [{ email: cleanEmail }, { username: cleanEmail }]
          }
        });
      }

      if (!user) {
        return sendError('Account not found. Please register or sign in again.', 404);
      }

      if (!user.otp_code || user.otp_code !== cleanOtp || user.otp_purpose !== 'VERIFY_EMAIL') {
        return sendError('Invalid OTP code. Please check the 6-digit code sent to your email and try again.');
      }

      if (user.otp_expires_at && new Date() > new Date(user.otp_expires_at)) {
        return sendError('This OTP code has expired. Please click "Resend OTP" to get a new code.');
      }

      user.email_verified = true;
      user.otp_code = null;
      user.otp_expires_at = null;
      user.otp_purpose = null;
      await user.save();

      await linkExistingReservationsToUser(user);

      const sessionUser = {
        id: user.id,
        username: user.username,
        full_name: user.full_name || user.username,
        email: user.email || '',
        phone: user.phone || '',
        fb_psid: user.fb_psid || null,
        binding_code: user.binding_code,
        email_verified: true,
        role: user.role
      };
      req.session.user = sessionUser;
      req.session.lastActiveAt = Date.now();

      await logAudit('PLAYER_EMAIL_VERIFIED', { email: user.email, phone: user.phone }, user.id);

      return req.session.save(() => {
        if (isAjax) {
          return res.json({
            success: true,
            user: sessionUser,
            message: `Email confirmed! Welcome to The Playground, ${sessionUser.full_name}!`
          });
        }

        req.flash('success', `Email confirmed! Welcome to The Playground, ${sessionUser.full_name}!`);
        res.redirect('/');
      });
    } catch (err) {
      next(err);
    }
  },

  async resendEmailOtp(req, res, next) {
    try {
      const { email, user_id, purpose } = req.body;
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');
      const targetPurpose = purpose === 'RESET_PASSWORD' ? 'RESET_PASSWORD' : 'VERIFY_EMAIL';

      const cleanEmail = email ? email.trim().toLowerCase() : '';
      let user = null;
      if (user_id) {
        user = await User.findByPk(user_id);
      }
      if (!user && cleanEmail) {
        user = await User.findOne({
          where: {
            [Op.or]: [{ email: cleanEmail }, { username: cleanEmail }]
          }
        });
      }

      if (!user) {
        const msg = 'Account not found. Please check your email address.';
        if (isAjax) return res.status(404).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/login');
      }

      // Allow legacy user without email (or updating unverified email) to set email before verification
      if (cleanEmail && (!user.email || !user.email_verified)) {
        if (!isValidEmail(cleanEmail)) {
          const msg = 'Please enter a valid email address.';
          if (isAjax) return res.status(400).json({ success: false, error: msg });
          req.flash('error', msg);
          return res.redirect('/account/login?mode=verify');
        }
        const existingEmailOwner = await User.findOne({
          where: {
            email: cleanEmail,
            id: { [Op.ne]: user.id }
          }
        });
        if (existingEmailOwner) {
          const msg = 'That email address is already linked to another account.';
          if (isAjax) return res.status(409).json({ success: false, error: msg });
          req.flash('error', msg);
          return res.redirect('/account/login?mode=verify');
        }
        user.email = cleanEmail;
      }

      if (!user.email) {
        const msg = 'Please enter a valid email address to receive your OTP.';
        if (isAjax) return res.status(400).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/login?mode=verify');
      }

      const otpCode = generateOtpCode();
      user.otp_code = otpCode;
      user.otp_expires_at = new Date(Date.now() + OTP_EXPIRY_MS);
      user.otp_purpose = targetPurpose;
      await user.save();

      const emailRes = targetPurpose === 'RESET_PASSWORD'
        ? await sendPasswordResetOTP(user.email, user.full_name, otpCode)
        : await sendEmailVerificationOTP(user.email, user.full_name, otpCode);

      const msg = `A new 6-digit OTP has been sent to ${user.email}.`;
      if (isAjax) {
        return res.json({
          success: true,
          email: user.email,
          user_id: user.id,
          mocked_otp: emailRes.mocked ? otpCode : undefined,
          message: msg
        });
      }

      req.flash('success', msg);
      const nextMode = targetPurpose === 'RESET_PASSWORD' ? 'reset' : 'verify';
      res.redirect(`/account/login?mode=${nextMode}&email=${encodeURIComponent(user.email)}`);
    } catch (err) {
      next(err);
    }
  },

  async forgotPasswordRequest(req, res, next) {
    try {
      const { identifier } = req.body;
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');

      const sendError = (msg, status = 400) => {
        if (isAjax) return res.status(status).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect('/account/login?mode=forgot');
      };

      if (!identifier || !identifier.trim()) {
        return sendError('Please enter your registered Email Address or GCash Mobile Number.');
      }

      const rawId = identifier.trim();
      const lowerId = rawId.toLowerCase();
      const normalizedMobile = normalizePhone(rawId);

      const orConditions = [
        { email: lowerId },
        { username: lowerId }
      ];
      if (normalizedMobile) {
        orConditions.push({ phone: normalizedMobile });
        orConditions.push({ username: normalizedMobile });
      }

      const user = await User.findOne({
        where: { [Op.or]: orConditions }
      });

      if (!user) {
        return sendError('No player account found with that email or mobile number.', 404);
      }

      if (!user.email) {
        return sendError('This account does not have a verified email address on file. Please contact The Playground admin for assistance.', 400);
      }

      const otpCode = generateOtpCode();
      user.otp_code = otpCode;
      user.otp_expires_at = new Date(Date.now() + OTP_EXPIRY_MS);
      user.otp_purpose = 'RESET_PASSWORD';
      await user.save();

      const emailRes = await sendPasswordResetOTP(user.email, user.full_name, otpCode);
      await logAudit('PLAYER_PASSWORD_RESET_OTP_SENT', { email: user.email, phone: user.phone }, user.id);

      const masked = maskEmail(user.email);
      const msg = `We sent a 6-digit password recovery code to ${masked}. Enter the code below to set a new password.`;

      if (isAjax) {
        return res.json({
          success: true,
          email: user.email,
          masked_email: masked,
          mocked_otp: emailRes.mocked ? otpCode : undefined,
          message: msg
        });
      }

      req.flash('success', msg);
      return res.redirect(`/account/login?mode=reset&email=${encodeURIComponent(user.email)}`);
    } catch (err) {
      next(err);
    }
  },

  async resetPasswordWithOtp(req, res, next) {
    try {
      const { email, otp_code, new_password, confirm_password } = req.body;
      const isAjax = req.xhr || req.headers.accept?.includes('application/json');

      const sendError = (msg, status = 400) => {
        if (isAjax) return res.status(status).json({ success: false, error: msg });
        req.flash('error', msg);
        return res.redirect(`/account/login?mode=reset&email=${encodeURIComponent(email || '')}`);
      };

      if (!email || !otp_code || !new_password) {
        return sendError('Email, 6-digit Recovery OTP, and New Password are required.');
      }

      if (new_password.length < 6) {
        return sendError('New password must be at least 6 characters long.');
      }

      if (confirm_password !== undefined && new_password !== confirm_password) {
        return sendError('New passwords do not match.');
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanOtp = String(otp_code).trim();

      const user = await User.findOne({
        where: {
          [Op.or]: [{ email: cleanEmail }, { username: cleanEmail }]
        }
      });

      if (!user) {
        return sendError('Account not found. Please try requesting a recovery code again.', 404);
      }

      if (!user.otp_code || user.otp_code !== cleanOtp || user.otp_purpose !== 'RESET_PASSWORD') {
        return sendError('Invalid recovery OTP code. Please check the 6-digit code sent to your email.');
      }

      if (user.otp_expires_at && new Date() > new Date(user.otp_expires_at)) {
        return sendError('This recovery OTP code has expired. Please request a new code.');
      }

      user.password_hash = await bcrypt.hash(new_password, 10);
      user.email_verified = true;
      user.otp_code = null;
      user.otp_expires_at = null;
      user.otp_purpose = null;
      await user.save();

      await linkExistingReservationsToUser(user);

      const sessionUser = {
        id: user.id,
        username: user.username,
        full_name: user.full_name || user.username,
        email: user.email || '',
        phone: user.phone || '',
        fb_psid: user.fb_psid || null,
        binding_code: user.binding_code,
        email_verified: true,
        role: user.role
      };
      req.session.user = sessionUser;
      req.session.lastActiveAt = Date.now();

      await logAudit('PLAYER_PASSWORD_RESET_COMPLETED', { email: user.email, phone: user.phone }, user.id);

      return req.session.save(() => {
        if (isAjax) {
          return res.json({
            success: true,
            user: sessionUser,
            message: `Password updated! Welcome back, ${sessionUser.full_name}!`
          });
        }

        req.flash('success', `Password updated! Welcome back, ${sessionUser.full_name}!`);
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

