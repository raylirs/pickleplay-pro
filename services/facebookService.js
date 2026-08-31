const { SystemSetting, Reservation, Court } = require('../models');
const { getIO } = require('../config/socket');

const FB_VERSION = 'v24.0';

/**
 * Get setting value helper
 */
async function getSetting(key) {
  const setting = await SystemSetting.findOne({ where: { key } });
  return setting ? setting.value : null;
}

/**
 * Send Facebook Messenger Notification
 */
async function sendMessengerNotify(psid, payload) {
  const token = await getSetting('fb_page_token');
  if (!token || !psid) {
    console.log('[FB Service] Page token or PSID missing, skipping FB notification.');
    return false;
  }

  try {
    const url = `https://graph.facebook.com/${FB_VERSION}/me/messages?access_token=${token}`;
    let messageBody = typeof payload === 'string' ? { text: payload } : payload;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        message: messageBody
      })
    });

    const data = await response.json();
    if (data.error) {
      console.error('[FB Messenger Error]:', data.error.message);
      return false;
    }
    console.log('[FB Service] Notification sent successfully to PSID:', psid, 'Message ID:', data.message_id);
    return true;
  } catch (error) {
    console.error('[FB Messenger Service Error]:', error.message);
    return false;
  }
}

/**
 * Fetch all Facebook Pages for a user using User Access Token
 */
async function fetchUserPages(userToken) {
  if (!userToken) throw new Error('User access token is required');
  const fields = 'id,name,access_token,category,picture{url}';
  const response = await fetch(`https://graph.facebook.com/${FB_VERSION}/me/accounts?fields=${fields}&access_token=${userToken}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

/**
 * Notify Admin when a new booking is submitted
 */
async function notifyAdminNewBooking(reservation) {
  const adminPsid = await getSetting('fb_admin_psid');
  if (!adminPsid) return;

  const msg = `🔔 [3KS PLAYGROUND] NEW BOOKING RECEIVED!\n\n` +
    `📋 Ref: ${reservation.reference_number}\n` +
    `👤 Player: ${reservation.user_name} (${reservation.user_contact})\n` +
    `🏟️ Court: Court ${reservation.court_id}\n` +
    `📅 Date: ${reservation.reservation_date}\n` +
    `⏰ Time: ${reservation.start_time}\n` +
    `💰 Total: ₱${parseFloat(reservation.total_amount).toFixed(2)}\n\n` +
    `👉 Verify GCash & Approve in Admin: https://pickleplay-pro.onrender.com/admin/reservations`;

  await sendMessengerNotify(adminPsid, msg);
}

/**
 * Notify Admin when a GCash payment proof is submitted
 */
async function notifyAdminPaymentProof(reservation) {
  const adminPsid = await getSetting('fb_admin_psid');
  if (!adminPsid) return;

  const msg = `💳 [3KS PLAYGROUND] GCASH PAYMENT SUBMITTED!\n\n` +
    `📋 Booking Ref: ${reservation.reference_number}\n` +
    `👤 Player: ${reservation.user_name}\n` +
    `🧾 GCash Ref: ${reservation.gcash_reference_no || 'Attached Screenshot'}\n` +
    `💰 Amount: ₱${parseFloat(reservation.total_amount).toFixed(2)}\n\n` +
    `👉 Approve Now: https://pickleplay-pro.onrender.com/admin/reservations`;

  await sendMessengerNotify(adminPsid, msg);
}

/**
 * Notify Player when their booking is CONFIRMED by Admin
 */
async function notifyPlayerBookingConfirmed(reservation) {
  if (!reservation.fb_psid) return;

  const msg = `🎉 [3KS PLAYGROUND] YOUR BOOKING IS CONFIRMED!\n\n` +
    `Hello ${reservation.user_name}! Your court reservation has been verified and confirmed by Admin.\n\n` +
    `📋 Booking Ref: ${reservation.reference_number}\n` +
    `🏟️ Court: Court ${reservation.court_id}\n` +
    `📅 Date: ${reservation.reservation_date}\n` +
    `⏰ Time: ${reservation.start_time}\n` +
    `💰 Amount Paid: ₱${parseFloat(reservation.total_amount).toFixed(2)}\n\n` +
    `🎟️ View Your Digital Pass: https://pickleplay-pro.onrender.com/reservations/${reservation.reference_number}\n\n` +
    `See you on the court! 🏓`;

  await sendMessengerNotify(reservation.fb_psid, msg);
}

/**
 * Webhook Verification Handler (GET /webhook/facebook)
 */
async function handleWebhookVerification(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = (await getSetting('fb_webhook_verify_token')) || '3ks_pickleball_secret';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[FB Webhook] Verified successfully.');
    res.status(200).send(challenge);
  } else {
    console.warn('[FB Webhook] Verification failed. Token mismatch.');
    res.sendStatus(403);
  }
}

/**
 * Webhook Event Handler (POST /webhook/facebook)
 * Auto-binds player Messenger PSID when they send their booking reference or 6-digit code!
 */
async function handleWebhookEvents(req, res) {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging ? entry.messaging[0] : null;
      if (!webhookEvent) continue;

      const senderId = webhookEvent.sender.id;

      // Handle message text or postback referral
      let incomingText = '';
      if (webhookEvent.message && webhookEvent.message.text) {
        incomingText = webhookEvent.message.text.trim();
      } else if (webhookEvent.postback && webhookEvent.postback.referral) {
        incomingText = webhookEvent.postback.referral.ref || '';
      } else if (webhookEvent.referral && webhookEvent.referral.ref) {
        incomingText = webhookEvent.referral.ref || '';
      }

      console.log(`[FB Webhook] Received event from PSID ${senderId}: "${incomingText}"`);

      if (incomingText) {
        // Clean text (e.g. "3KS-8492" or "3KS2026A1B2" or "bind 3ks-8492")
        const cleanedCode = incomingText.toUpperCase().replace(/[^A-Z0-9-]/g, '');

        // 1. Search by booking reference or binding_code
        const { Op } = require('sequelize');
        const reservation = await Reservation.findOne({
          where: {
            [Op.or]: [
              { reference_number: cleanedCode },
              { binding_code: cleanedCode },
              { reference_number: { [Op.like]: `%${cleanedCode}%` } },
              { binding_code: { [Op.like]: `%${cleanedCode}%` } }
            ]
          },
          include: [{ model: Court, as: 'court' }]
        });

        if (reservation) {
          console.log(`[FB Webhook] Found matching reservation ${reservation.reference_number}! Binding to PSID ${senderId}...`);
          reservation.fb_psid = senderId;
          await reservation.save();

          // Real-time socket event to browser
          try {
            const io = getIO();
            io.emit('player_messenger_bound', {
              reference: reservation.reference_number,
              psid: senderId
            });
          } catch (e) {}

          // Reply in Messenger
          const replyText = `✅ [3KS PLAYGROUND] Connected!\n\n` +
            `Hello ${reservation.user_name}! Your Facebook Messenger is now linked to Reservation #${reservation.reference_number}.\n\n` +
            `📅 Date: ${reservation.reservation_date} (${reservation.start_time})\n` +
            `🏟️ Court: ${reservation.court ? reservation.court.display_name : 'Court ' + reservation.court_id}\n\n` +
            `You will receive instant confirmation & pass updates right here! 🏓`;

          await sendMessengerNotify(senderId, replyText);
        } else {
          // If no matching reservation code, send helpful instructions
          if (incomingText.toLowerCase().includes('hi') || incomingText.toLowerCase().includes('hello') || incomingText.toLowerCase().includes('help')) {
            const helpText = `👋 Hello! Welcome to 3KS Pickleball Playground.\n\n` +
              `To link your court booking for alerts, simply reply with your Booking Reference Number or 6-digit Code (e.g. 3KS-1234).\n\n` +
              `🌐 Book online: https://pickleplay-pro.onrender.com`;
            await sendMessengerNotify(senderId, helpText);
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
}

module.exports = {
  sendMessengerNotify,
  fetchUserPages,
  notifyAdminNewBooking,
  notifyAdminPaymentProof,
  notifyPlayerBookingConfirmed,
  handleWebhookVerification,
  handleWebhookEvents,
  getSetting
};
