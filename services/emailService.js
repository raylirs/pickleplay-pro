const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { formatCurrency, formatTime12 } = require('../utils/dateTimeUtils');
const { Op } = require('sequelize');
const { SystemSetting, Court, Reservation } = require('../models');

async function resolveSmtpConfig() {
  let dbSettings = {};
  try {
    const rows = await SystemSetting.findAll({
      where: {
        key: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL']
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
  const port = parseInt(dbSettings.SMTP_PORT || process.env.SMTP_PORT || '465', 10);
  const user = dbSettings.SMTP_USER || process.env.SMTP_USER || '';
  const pass = dbSettings.SMTP_PASS || process.env.SMTP_PASS || '';
  const fromName = dbSettings.SMTP_FROM_NAME || 'The Playground Pickleball';
  const brevoApiKey = dbSettings.BREVO_API_KEY || process.env.BREVO_API_KEY || '';
  const brevoSender = dbSettings.BREVO_SENDER_EMAIL || process.env.BREVO_SENDER_EMAIL || user || 'cpe4ryan@gmail.com';

  const isMock = !brevoApiKey && (!user || !pass || user === 'mock_user@pickleplay.com' || pass === 'mock_password');

  return { host, port, user, pass, fromName, brevoApiKey, brevoSender, isMock };
}

let cachedTransporter = null;
let cachedTransporterKey = null;

async function createDynamicTransporter() {
  const cfg = await resolveSmtpConfig();
  if (cfg.isMock) {
    return { transporter: null, cfg };
  }

  const isGmail = cfg.host === 'smtp.gmail.com' || (cfg.user && cfg.user.includes('@gmail.com'));
  const currentKey = `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.pass}:${isGmail}`;

  if (cachedTransporter && cachedTransporterKey === currentKey) {
    return { transporter: cachedTransporter, cfg };
  }

  const transportOpts = isGmail
    ? {
        service: 'gmail',
        auth: {
          user: cfg.user,
          pass: cfg.pass
        },
        pool: true,
        maxConnections: 3,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
      }
    : {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.port === 465,
        auth: {
          user: cfg.user,
          pass: cfg.pass
        },
        pool: true,
        maxConnections: 3,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
      };

  cachedTransporter = nodemailer.createTransport(transportOpts);
  cachedTransporterKey = currentKey;

  return { transporter: cachedTransporter, cfg };
}

/**
 * Universal email dispatcher:
 * 1. Brevo HTTPS API (Port 443 - Bypasses Render Free Tier outbound SMTP port restrictions, delivers to ANY email address)
 * 2. Standard SMTP / Gmail (Nodemailer - Used on local dev or paid Render tiers)
 */
async function dispatchEmail({ to, subject, html, attachments }) {
  const cfg = await resolveSmtpConfig();
  const toList = (Array.isArray(to) ? to : String(to).split(/[\s,]+/))
    .map(e => e.trim())
    .filter(Boolean);

  if (toList.length === 0) {
    return { success: false, reason: 'No recipients specified' };
  }

  // 1. Try Brevo HTTPS API (Port 443 - Never blocked on Render Free)
  if (cfg.brevoApiKey) {
    try {
      const brevoBody = {
        sender: { name: cfg.fromName, email: cfg.brevoSender },
        to: toList.map(email => ({ email })),
        subject,
        htmlContent: html
      };

      if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        brevoBody.attachment = attachments.map(att => {
          if (att.content && typeof att.content === 'string') {
            return { name: att.filename, content: att.content };
          } else if (att.path && fs.existsSync(att.path)) {
            return { name: att.filename, content: fs.readFileSync(att.path).toString('base64') };
          } else if (att.url) {
            return { name: att.filename, url: att.url };
          }
          return null;
        }).filter(Boolean);
      }

      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': cfg.brevoApiKey.trim(),
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(brevoBody),
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      if (res.ok && data.messageId) {
        console.log(`[Email Service Brevo] Successfully delivered to ${toList.join(', ')} (Message ID: ${data.messageId})`);
        return { success: true, mocked: false, provider: 'brevo', messageId: data.messageId };
      } else {
        const errorMsg = data.message || JSON.stringify(data);
        console.warn(`[Email Service Brevo Error]: ${errorMsg}`);
      }
    } catch (err) {
      console.warn(`[Email Service Brevo Error]: ${err.message}`);
    }
  }

  // 2. Try Standard SMTP / Gmail (Nodemailer)
  const { transporter } = await createDynamicTransporter();
  if (transporter) {
    try {
      const mailOptions = {
        from: `"${cfg.fromName}" <${cfg.user}>`,
        to: toList.join(', '),
        subject,
        html
      };
      if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        mailOptions.attachments = attachments;
      }
      const info = await transporter.sendMail(mailOptions);
      console.log(`[Email Service Gmail] Successfully delivered to ${toList.join(', ')} (Message ID: ${info.messageId})`);
      return { success: true, mocked: false, provider: 'smtp', messageId: info.messageId };
    } catch (err) {
      console.warn(`[Email Service Gmail Error] Delivery failed to ${toList.join(', ')}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  return { success: false, reason: 'No active email provider configured' };
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

  const result = await dispatchEmail({
    to: reservation.user_email,
    subject: `Reservation Confirmed - ${reservation.reference_number} (The Playground Pickleball)`,
    html: emailHtml
  });

  if (result.success && !result.mocked) {
    return { success: true, messageId: result.messageId };
  }

  console.log(`[Email Service Mock] Email to ${reservation.user_email}: Confirmed booking ${reservation.reference_number}${result.error ? ` (${result.error})` : ''}`);
  return { success: true, mocked: true };
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

  const result = await dispatchEmail({
    to: email,
    subject: `${otpCode} is your verification code - The Playground Pickleball`,
    html: emailHtml
  });

  if (result.success && !result.mocked) {
    return { success: true, mocked: false, messageId: result.messageId };
  }

  console.log(`[Email Service Mock] Verification OTP to ${email}: ${otpCode}${result.error ? ` (${result.error})` : ''}`);
  return { success: true, mocked: true, otpCode, error: result.error || result.reason };
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

  const result = await dispatchEmail({
    to: email,
    subject: `${otpCode} is your password recovery code - The Playground Pickleball`,
    html: emailHtml
  });

  if (result.success && !result.mocked) {
    return { success: true, mocked: false, messageId: result.messageId };
  }

  console.log(`[Email Service Mock] Password Reset OTP to ${email}: ${otpCode}${result.error ? ` (${result.error})` : ''}`);
  return { success: true, mocked: true, otpCode, error: result.error || result.reason };
}

async function getAdminAlertEmails() {
  let emails = [];
  try {
    const setting = await SystemSetting.findOne({ where: { key: 'ADMIN_ALERT_EMAILS' } });
    if (setting && setting.value) {
      emails = setting.value.split(/[\s,]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
    }
  } catch (e) {}

  if (emails.length === 0 && process.env.ADMIN_ALERT_EMAILS) {
    emails = process.env.ADMIN_ALERT_EMAILS.split(/[\s,]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
  }

  if (emails.length === 0) {
    emails = ['cpe4ryan@gmail.com', 'karlopagador44@gmail.com'];
  }

  return [...new Set(emails)];
}

async function notifyAdminsNewBookingEmail(reservation, extra = {}) {
  const recipients = await getAdminAlertEmails();
  if (!recipients || recipients.length === 0) return;

  let courtLabel = extra.courtSummary;
  if (!courtLabel) {
    if (reservation.court && reservation.court.display_name) {
      courtLabel = reservation.court.display_name;
    } else {
      try {
        const masterRef = (reservation.reference_number || '').split('-')[0];
        const siblings = await Reservation.findAll({
          where: {
            reference_number: {
              [Op.or]: [masterRef, { [Op.like]: `${masterRef}-%` }]
            }
          },
          include: [{ model: Court, as: 'court' }]
        });
        if (siblings && siblings.length > 0) {
          const names = [...new Set(siblings.map(s => s.court ? s.court.display_name : `Court ${s.court_id}`))];
          courtLabel = names.join(', ');
        }
      } catch (e) {}
      if (!courtLabel) {
        try {
          const courtObj = await Court.findByPk(reservation.court_id);
          courtLabel = courtObj ? courtObj.display_name : `Court ${reservation.court_id}`;
        } catch(e) {}
      }
    }
  }
  if (!courtLabel) courtLabel = `Court ${reservation.court_id}`;
  const totalAmount = extra.totalAmount !== undefined ? parseFloat(extra.totalAmount) : parseFloat(reservation.total_amount || 0);
  const timeRange = reservation.end_time ? `${reservation.start_time} - ${reservation.end_time}` : reservation.start_time;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px;">
      <div style="background: linear-gradient(135deg, #0B2545 0%, #134074 100%); color: white; padding: 18px; text-align: center; border-radius: 8px 8px 0 0; border-bottom: 3px solid #E5C365;">
        <h2 style="margin: 0; font-size: 20px;">The Playground Pickleball</h2>
        <p style="margin: 5px 0 0 0; font-size: 14px; color: #E5C365; font-weight: bold;">🔔 New Court Booking Received</p>
      </div>
      <div style="padding: 20px; color: #1e293b;">
        <p>A new player reservation has been placed on the website:</p>
        <div style="background-color: #f8fafc; border-left: 4px solid #0B2545; padding: 14px 18px; margin: 15px 0;">
          <p style="margin: 0 0 6px 0;"><strong>Ref Number:</strong> <span style="font-family: monospace; font-size: 15px; color: #0d6efd;">${reservation.reference_number}</span></p>
          <p style="margin: 0 0 6px 0;"><strong>Player Name:</strong> ${reservation.user_name}</p>
          <p style="margin: 0 0 6px 0;"><strong>Contact / GCash:</strong> ${reservation.user_contact}</p>
          <p style="margin: 0 0 6px 0;"><strong>Email:</strong> ${reservation.user_email || 'Not provided'}</p>
          <p style="margin: 0 0 6px 0;"><strong>Court:</strong> ${courtLabel}</p>
          <p style="margin: 0 0 6px 0;"><strong>Date:</strong> ${reservation.reservation_date}</p>
          <p style="margin: 0 0 6px 0;"><strong>Time:</strong> ${timeRange}</p>
          <p style="margin: 0 0 6px 0;"><strong>Total Amount:</strong> ${formatCurrency(totalAmount)}</p>
          <p style="margin: 0;"><strong>Status:</strong> <span style="background-color: #fff3cd; color: #856404; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;">⏳ Awaiting GCash Payment (15-min hold)</span></p>
        </div>
        <p style="margin-top: 15px;">
          <a href="https://pickleplay-pro.onrender.com/admin/reservations" style="display: inline-block; background-color: #0B2545; color: #ffffff; padding: 10px 22px; text-decoration: none; border-radius: 20px; font-weight: bold; font-size: 13px;">View in Admin Dashboard &rarr;</a>
        </p>
      </div>
      <div style="text-align: center; font-size: 11px; color: #94a3b8; padding-top: 15px; border-top: 1px solid #eee;">
        Sent automatically to Admins (Ryan &amp; Karlo) &bull; The Playground Pickleball
      </div>
    </div>
  `;

  await dispatchEmail({
    to: recipients,
    subject: `[Booking Alert] ${reservation.user_name} - ${courtLabel} (${reservation.reservation_date})`,
    html: emailHtml
  });
}

async function notifyAdminsPaymentProofEmail(reservation, totalOrderAmount) {
  const recipients = await getAdminAlertEmails();
  if (!recipients || recipients.length === 0) return;

  const totalAmount = totalOrderAmount !== undefined ? parseFloat(totalOrderAmount) : parseFloat(reservation.total_amount || 0);

  const baseUrl = process.env.APP_URL && process.env.APP_URL.startsWith('https://')
    ? process.env.APP_URL.replace(/\/$/, '')
    : 'https://pickleplay-pro.onrender.com';

  const screenshotUrl = reservation.payment_screenshot
    ? (reservation.payment_screenshot.startsWith('http')
        ? reservation.payment_screenshot
        : `${baseUrl}${reservation.payment_screenshot}`)
    : '';

  const attachments = [];
  let screenshotHtml = '';

  if (reservation.payment_screenshot) {
    const localRelPath = reservation.payment_screenshot.replace(/^\//, '');
    const localPath = path.join(__dirname, '..', 'public', localRelPath);
    const filename = `gcash-proof-${reservation.reference_number}.jpg`;

    if (fs.existsSync(localPath)) {
      attachments.push({
        filename,
        path: localPath,
        cid: 'gcashScreenshot'
      });
      screenshotHtml = `
        <div style="margin: 20px 0; text-align: center; background: #f8fafc; padding: 16px; border-radius: 8px; border: 1.5px dashed #cbd5e1;">
          <p style="margin: 0 0 10px 0; font-size: 13px; font-weight: bold; color: #334155;">📷 GCash Payment Screenshot (Attached):</p>
          <a href="${screenshotUrl || '#'}" target="_blank" style="text-decoration: none; display: inline-block;">
            <img src="cid:gcashScreenshot" alt="GCash Screenshot" style="max-width: 100%; max-height: 480px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #cbd5e1; display: block; margin: 0 auto;" />
          </a>
          <p style="margin: 10px 0 0 0; font-size: 11px; color: #64748b;">(Click image or check email attachments to view high-resolution proof)</p>
        </div>
      `;
    } else if (screenshotUrl) {
      attachments.push({
        filename,
        url: screenshotUrl
      });
      screenshotHtml = `
        <div style="margin: 20px 0; text-align: center; background: #f8fafc; padding: 16px; border-radius: 8px; border: 1.5px dashed #cbd5e1;">
          <p style="margin: 0 0 10px 0; font-size: 13px; font-weight: bold; color: #334155;">📷 GCash Payment Screenshot Preview:</p>
          <a href="${screenshotUrl}" target="_blank" style="text-decoration: none; display: inline-block;">
            <img src="${screenshotUrl}" alt="GCash Screenshot" style="max-width: 100%; max-height: 480px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #cbd5e1; display: block; margin: 0 auto;" />
          </a>
          <p style="margin: 10px 0 0 0; font-size: 11px; color: #64748b;">(Click image to view high-resolution proof)</p>
        </div>
      `;
    }
  }

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px;">
      <div style="background: linear-gradient(135deg, #198754 0%, #157347 100%); color: white; padding: 18px; text-align: center; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0; font-size: 20px;">The Playground Pickleball</h2>
        <p style="margin: 5px 0 0 0; font-size: 14px; color: #d1e7dd; font-weight: bold;">🧾 GCash Payment Proof Uploaded</p>
      </div>
      <div style="padding: 20px; color: #1e293b;">
        <p>A player has submitted their GCash payment receipt for admin verification:</p>
        <div style="background-color: #f8fafc; border-left: 4px solid #198754; padding: 14px 18px; margin: 15px 0;">
          <p style="margin: 0 0 6px 0;"><strong>Booking Ref:</strong> <span style="font-family: monospace; font-size: 15px; color: #0d6efd;">${reservation.reference_number}</span></p>
          <p style="margin: 0 0 6px 0;"><strong>Player Name:</strong> ${reservation.user_name}</p>
          <p style="margin: 0 0 6px 0;"><strong>GCash Ref Number:</strong> <span style="font-family: monospace; font-weight: bold;">${reservation.gcash_reference_no || 'Uploaded'}</span></p>
          <p style="margin: 0;"><strong>Total Paid:</strong> ${formatCurrency(totalAmount)}</p>
        </div>

        ${screenshotHtml}

        <p style="margin-top: 20px; text-align: center;">
          <a href="${baseUrl}/admin/reservations?ref=${reservation.reference_number}" style="display: inline-block; background-color: #198754; color: #ffffff; padding: 12px 26px; text-decoration: none; border-radius: 20px; font-weight: bold; font-size: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">Review &amp; Approve in Admin Dashboard &rarr;</a>
        </p>
      </div>
      <div style="text-align: center; font-size: 11px; color: #94a3b8; padding-top: 15px; border-top: 1px solid #eee;">
        Sent automatically to Admins (Ryan &amp; Karlo) &bull; The Playground Pickleball
      </div>
    </div>
  `;

  await dispatchEmail({
    to: recipients,
    subject: `[GCash Proof] ${reservation.user_name} - ${reservation.reference_number} (${formatCurrency(totalAmount)})`,
    html: emailHtml,
    attachments
  });
}

module.exports = {
  sendReservationConfirmation,
  sendEmailVerificationOTP,
  sendPasswordResetOTP,
  notifyAdminsNewBookingEmail,
  notifyAdminsPaymentProofEmail,
  resolveSmtpConfig
};
