const nodemailer = require('nodemailer');
const { formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');
const { SystemSetting } = require('../models');

async function resolveSmtpConfig() {
  let dbSettings = {};
  try {
    const rows = await SystemSetting.findAll({
      where: {
        key: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME']
      }
    });
    rows.forEach(r => {
      if (r.value && String(r.value).trim()) {
        dbSettings[r.key] = String(r.value).trim();
      }
    });
  } catch (e) {
    // Ignore DB lookup errors and fall back to env
  }

  const host = dbSettings.SMTP_HOST || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(dbSettings.SMTP_PORT || process.env.SMTP_PORT || '587', 10);
  const user = dbSettings.SMTP_USER || process.env.SMTP_USER || '';
  const pass = dbSettings.SMTP_PASS || process.env.SMTP_PASS || '';
  const fromName = dbSettings.SMTP_FROM_NAME || 'The Playground Pickleball';

  const isMock = !user || !pass || user === 'mock_user@pickleplay.com' || pass === 'mock_password';

  return { host, port, user, pass, fromName, isMock };
}

async function createDynamicTransporter() {
  const cfg = await resolveSmtpConfig();
  if (cfg.isMock) {
    return { transporter: null, cfg };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: {
      user: cfg.user,
      pass: cfg.pass
    }
  });

  return { transporter, cfg };
}

async function sendReservationConfirmation(reservation, court) {
  if (!reservation.user_email) {
    return { success: false, reason: 'No email address provided' };
  }

  const courtName = court ? court.display_name : 'Pickleball Court';
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px;">
      <div style="background: linear-gradient(135deg, #0B2545 0%, #134074 100%); color: white; padding: 18px; text-align: center; border-radius: 8px 8px 0 0; border-bottom: 3px solid #E5C365;">
        <h2 style="margin: 0;">The Playground Pickleball</h2>
        <p style="margin: 5px 0 0 0; font-size: 14px; color: #E5C365;">Reservation Confirmed</p>
      </div>
      <div style="padding: 20px;">
        <p>Hi <strong>${reservation.user_name}</strong>,</p>
        <p>Your pickleball court reservation has been successfully confirmed!</p>
        
        <div style="background-color: #f8f9fa; border-left: 4px solid #198754; padding: 15px; margin: 20px 0;">
          <p style="margin: 0 0 8px 0;"><strong>Reference Number:</strong> <span style="font-family: monospace; font-size: 16px; color: #0d6efd;">${reservation.reference_number}</span></p>
          <p style="margin: 0 0 8px 0;"><strong>Court:</strong> ${courtName}</p>
          <p style="margin: 0 0 8px 0;"><strong>Date:</strong> ${reservation.reservation_date}</p>
          <p style="margin: 0 0 8px 0;"><strong>Time:</strong> ${formatTime12(reservation.start_time)} - ${formatTime12(reservation.end_time)} (${reservation.total_hours} hr/s)</p>
          <p style="margin: 0;"><strong>Total Paid:</strong> ${formatCurrency(reservation.total_amount)} via GCash</p>
        </div>

        <p style="font-size: 13px; color: #6c757d;">Please present this confirmation upon arrival at the court facility. Have a great game!</p>
      </div>
      <div style="text-align: center; font-size: 12px; color: #999; padding-top: 15px; border-top: 1px solid #eee;">
        &copy; ${new Date().getFullYear()} The Playground Pickleball Court Reservation System.
      </div>
    </div>
  `;

  try {
    const { transporter, cfg } = await createDynamicTransporter();
    if (!transporter) {
      console.log(`[Email Service Mock] Email to ${reservation.user_email}: Confirmed booking ${reservation.reference_number}`);
      return { success: true, mocked: true };
    }
    const info = await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.user}>`,
      to: reservation.user_email,
      subject: `Reservation Confirmed - ${reservation.reference_number} (The Playground Pickleball)`,
      html: emailHtml
    });
    console.log(`[Email Service] Confirmation email sent to ${reservation.user_email}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.log(`[Email Service Mock] Email to ${reservation.user_email}: Confirmed booking ${reservation.reference_number} (${err.message})`);
    return { success: true, mocked: true };
  }
}

async function sendEmailVerificationOTP(email, fullName, otpCode) {
  if (!email) {
    return { success: false, reason: 'No email address provided' };
  }

  const displayName = fullName || 'Player';
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #0B2545 0%, #134074 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; border-bottom: 3px solid #E5C365;">
        <h2 style="margin: 0; font-size: 20px;">The Playground Pickleball</h2>
        <p style="margin: 5px 0 0 0; font-size: 13px; color: #E5C365;">Verify Your Email Address</p>
      </div>
      <div style="padding: 24px 20px; color: #1e293b;">
        <p style="margin-top: 0;">Hi <strong>${displayName}</strong>,</p>
        <p style="line-height: 1.5;">Thank you for creating a player account at <strong>The Playground Pickleball</strong>! Please enter the 6-digit One-Time Password (OTP) below to confirm your email address:</p>
        
        <div style="background-color: #f8fafc; border: 2px dashed #0B2545; border-radius: 10px; padding: 18px; margin: 24px 0; text-align: center;">
          <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 6px;">Your Verification Code</div>
          <div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #0B2545;">${otpCode}</div>
          <div style="font-size: 12px; color: #64748b; margin-top: 8px;">Valid for 10 minutes</div>
        </div>

        <p style="font-size: 13px; color: #64748b; line-height: 1.5;">Once your email is confirmed, you can also use this email address anytime to recover your account if you ever forget your password.</p>
      </div>
      <div style="text-align: center; font-size: 12px; color: #94a3b8; padding-top: 15px; border-top: 1px solid #f1f5f9;">
        &copy; ${new Date().getFullYear()} The Playground Pickleball. If you did not request this code, please ignore this email.
      </div>
    </div>
  `;

  try {
    const { transporter, cfg } = await createDynamicTransporter();
    if (!transporter) {
      console.log(`[Email Service Mock] Verification OTP to ${email}: ${otpCode}`);
      return { success: true, mocked: true, otpCode };
    }
    const info = await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.user}>`,
      to: email,
      subject: `${otpCode} is your verification code - The Playground Pickleball`,
      html: emailHtml
    });
    console.log(`[Email Service] Verification OTP email sent to ${email}: ${info.messageId}`);
    return { success: true, mocked: false, messageId: info.messageId };
  } catch (err) {
    console.log(`[Email Service Mock] Verification OTP to ${email}: ${otpCode} (SMTP fallback: ${err.message})`);
    return { success: true, mocked: true, otpCode, error: err.message };
  }
}

async function sendPasswordResetOTP(email, fullName, otpCode) {
  if (!email) {
    return { success: false, reason: 'No email address provided' };
  }

  const displayName = fullName || 'Player';
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #0B2545 0%, #134074 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; border-bottom: 3px solid #E5C365;">
        <h2 style="margin: 0; font-size: 20px;">The Playground Pickleball</h2>
        <p style="margin: 5px 0 0 0; font-size: 13px; color: #E5C365;">Password Recovery OTP</p>
      </div>
      <div style="padding: 24px 20px; color: #1e293b;">
        <p style="margin-top: 0;">Hi <strong>${displayName}</strong>,</p>
        <p style="line-height: 1.5;">We received a request to reset your password for your <strong>The Playground Pickleball</strong> player account. Enter the 6-digit recovery code below to set a new password:</p>
        
        <div style="background-color: #fffbeb; border: 2px dashed #d97706; border-radius: 10px; padding: 18px; margin: 24px 0; text-align: center;">
          <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #92400e; margin-bottom: 6px;">Password Recovery Code</div>
          <div style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #b45309;">${otpCode}</div>
          <div style="font-size: 12px; color: #92400e; margin-top: 8px;">Valid for 10 minutes</div>
        </div>

        <p style="font-size: 13px; color: #64748b; line-height: 1.5;">If you did not request a password reset, your account is safe and you can disregard this email.</p>
      </div>
      <div style="text-align: center; font-size: 12px; color: #94a3b8; padding-top: 15px; border-top: 1px solid #f1f5f9;">
        &copy; ${new Date().getFullYear()} The Playground Pickleball.
      </div>
    </div>
  `;

  try {
    const { transporter, cfg } = await createDynamicTransporter();
    if (!transporter) {
      console.log(`[Email Service Mock] Password Reset OTP to ${email}: ${otpCode}`);
      return { success: true, mocked: true, otpCode };
    }
    const info = await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.user}>`,
      to: email,
      subject: `${otpCode} is your password recovery code - The Playground Pickleball`,
      html: emailHtml
    });
    console.log(`[Email Service] Password Reset OTP email sent to ${email}: ${info.messageId}`);
    return { success: true, mocked: false, messageId: info.messageId };
  } catch (err) {
    console.log(`[Email Service Mock] Password Reset OTP to ${email}: ${otpCode} (SMTP fallback: ${err.message})`);
    return { success: true, mocked: true, otpCode, error: err.message };
  }
}

module.exports = {
  sendReservationConfirmation,
  sendEmailVerificationOTP,
  sendPasswordResetOTP,
  resolveSmtpConfig
};
