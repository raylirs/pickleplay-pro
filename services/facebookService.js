const { SystemSetting, Reservation, Court } = require('../models');
const { getIO } = require('../config/socket');
const { Op } = require('sequelize');

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
    console.log('[FB Service] Message delivered to PSID:', psid, 'ID:', data.message_id);
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
 * Helper to get all Admin PSIDs (supports multiple comma/space-separated PSIDs and active toggle states)
 */
async function getAllAdminPsids() {
  const ryanActive = (await getSetting('fb_admin_ryan_active')) !== 'false';
  const karloActive = (await getSetting('fb_admin_karlo_active')) !== 'false';

  const activePsids = [];
  if (ryanActive) activePsids.push('27030144379994794');
  if (karloActive) activePsids.push('38090624017219189');

  const raw = await getSetting('fb_admin_psid');
  if (raw) {
    const parsed = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    for (const p of parsed) {
      if (p !== '27030144379994794' && p !== '38090624017219189' && !activePsids.includes(p)) {
        activePsids.push(p);
      }
    }
  }
  return activePsids;
}

/**
 * Notify Admin when a new booking is submitted (with 1-Click Interactive Buttons)
 */
async function notifyAdminNewBooking(reservation) {
  const adminPsids = await getAllAdminPsids();
  if (!adminPsids || adminPsids.length === 0) return;

  const text = `🔔 [3KS] NEW BOOKING RECEIVED!\n\n` +
    `📋 Ref: ${reservation.reference_number}\n` +
    `👤 Player: ${reservation.user_name} (${reservation.user_contact})\n` +
    `🏟️ Court: Court ${reservation.court_id} | 📅 ${reservation.reservation_date}\n` +
    `⏰ Time: ${reservation.start_time}\n` +
    `💰 Total: ₱${parseFloat(reservation.total_amount).toFixed(2)}`;

  const buttonPayload = {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: [
          {
            type: 'postback',
            title: '✅ 1-Click Approve',
            payload: `APPROVE_${reservation.reference_number}`
          },
          {
            type: 'postback',
            title: '❌ Cancel Slot',
            payload: `CANCEL_${reservation.reference_number}`
          },
          {
            type: 'web_url',
            url: 'https://pickleplay-pro.onrender.com/admin/reservations',
            title: '👁️ Open Admin'
          }
        ]
      }
    }
  };

  for (const psid of adminPsids) {
    await sendMessengerNotify(psid, buttonPayload);
  }
}

/**
 * Notify Admin when a GCash payment proof is submitted (with 1-Click Interactive Buttons)
 */
async function notifyAdminPaymentProof(reservation) {
  const adminPsids = await getAllAdminPsids();
  if (!adminPsids || adminPsids.length === 0) return;

  const text = `💳 [3KS] GCASH PAYMENT SUBMITTED!\n\n` +
    `📋 Ref: ${reservation.reference_number}\n` +
    `👤 Player: ${reservation.user_name}\n` +
    `🧾 GCash Ref: ${reservation.gcash_reference_no || 'Attached Screenshot'}\n` +
    `💰 Amount: ₱${parseFloat(reservation.total_amount).toFixed(2)}`;

  const buttonPayload = {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: [
          {
            type: 'postback',
            title: '✅ Approve & Confirm',
            payload: `APPROVE_${reservation.reference_number}`
          },
          {
            type: 'postback',
            title: '❌ Reject/Cancel',
            payload: `CANCEL_${reservation.reference_number}`
          },
          {
            type: 'web_url',
            url: 'https://pickleplay-pro.onrender.com/admin/reservations',
            title: '👁️ View in Admin'
          }
        ]
      }
    }
  };

  for (const psid of adminPsids) {
    await sendMessengerNotify(psid, buttonPayload);
  }
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
 * Process Admin 1-Click Action (Confirm or Cancel via Messenger buttons/messages)
 */
async function processAdminAction(senderId, rawText) {
  const adminPsids = await getAllAdminPsids();
  if (!adminPsids.includes(senderId)) return false;

  const upper = (rawText || '').trim().toUpperCase();
  const isApprove = upper.startsWith('APPROVE_') || upper.startsWith('CONFIRM_') || upper.startsWith('APPROVE ') || upper.startsWith('CONFIRM ');
  const isCancel = upper.startsWith('CANCEL_') || upper.startsWith('REJECT_') || upper.startsWith('CANCEL ') || upper.startsWith('REJECT ');

  if (!isApprove && !isCancel) return false;

  const refMatch = upper.replace(/^(APPROVE_|CONFIRM_|CANCEL_|REJECT_|APPROVE\s+|CONFIRM\s+|CANCEL\s+|REJECT\s+)/, '').trim();
  if (!refMatch) return false;

  const { getCourtAvailability } = require('./availabilityService');

  const reservation = await Reservation.findOne({
    where: {
      [Op.or]: [
        { reference_number: refMatch },
        { reference_number: { [Op.like]: `%${refMatch}%` } },
        { binding_code: refMatch },
        { binding_code: { [Op.like]: `%${refMatch}%` } }
      ]
    },
    include: [{ model: Court, as: 'court' }]
  });

  if (!reservation) {
    await sendMessengerNotify(senderId, `⚠️ Reservation "${refMatch}" not found.`);
    return true;
  }

  if (isApprove) {
    reservation.status = 'CONFIRMED';
    reservation.payment_transaction_id = `MESSENGER-1CLICK-${Date.now()}`;
    await reservation.save();

    // Send confirmed pass to player if bound
    await notifyPlayerBookingConfirmed(reservation);

    // Broadcast real-time availability update to all browsers
    try {
      const io = getIO();
      const avail = await getCourtAvailability(reservation.court_id, reservation.reservation_date);
      io.emit('court_availability_updated', {
        courtId: reservation.court_id,
        date: reservation.reservation_date,
        slots: avail.slots
      });
      io.emit('payment_confirmed', {
        reference: reservation.reference_number,
        courtId: reservation.court_id
      });
    } catch (e) {}

    await sendMessengerNotify(senderId, `🎉 [1-CLICK APPROVED] Reservation #${reservation.reference_number} for ${reservation.user_name} is now CONFIRMED!\n\nPlayer has been sent their confirmed digital pass on Messenger.`);
    return true;
  }

  if (isCancel) {
    reservation.status = 'CANCELLED';
    reservation.cancellation_reason = 'Cancelled by Admin via 1-Click Messenger';
    await reservation.save();

    try {
      const io = getIO();
      const avail = await getCourtAvailability(reservation.court_id, reservation.reservation_date);
      io.emit('court_availability_updated', {
        courtId: reservation.court_id,
        date: reservation.reservation_date,
        slots: avail.slots
      });
    } catch (e) {}

    if (reservation.fb_psid) {
      await sendMessengerNotify(reservation.fb_psid, `⚠️ [3KS PLAYGROUND] Your booking #${reservation.reference_number} has been cancelled by Admin.`);
    }

    await sendMessengerNotify(senderId, `❌ [1-CLICK CANCELLED] Reservation #${reservation.reference_number} has been cancelled and slots released.`);
    return true;
  }

  return false;
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
 */
async function handleWebhookEvents(req, res) {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging ? entry.messaging[0] : null;
      if (!webhookEvent) continue;

      const senderId = webhookEvent.sender.id;

      let incomingText = '';
      if (webhookEvent.postback && webhookEvent.postback.payload) {
        incomingText = webhookEvent.postback.payload.trim();
      } else if (webhookEvent.message && webhookEvent.message.text) {
        incomingText = webhookEvent.message.text.trim();
      } else if (webhookEvent.postback && webhookEvent.postback.referral) {
        incomingText = webhookEvent.postback.referral.ref || '';
      } else if (webhookEvent.referral && webhookEvent.referral.ref) {
        incomingText = webhookEvent.referral.ref || '';
      }

      console.log(`[FB Webhook] Received event from PSID ${senderId}: "${incomingText}"`);

      if (incomingText) {
        // 1. Check if this is an Admin 1-Click Approve/Cancel action
        const handledAdmin = await processAdminAction(senderId, incomingText);
        if (handledAdmin) continue;

        // 2. Otherwise, check for player booking binding
        const cleanedText = incomingText.trim().toUpperCase();
        const compactText = cleanedText.replace(/\s+/g, '').replace(/–|—/g, '-');
        const digitsOnly = incomingText.replace(/\D/g, '');

        const searchConditions = [
          { reference_number: compactText },
          { binding_code: compactText },
          { reference_number: { [Op.like]: `%${compactText}%` } },
          { binding_code: { [Op.like]: `%${compactText}%` } }
        ];

        if (digitsOnly.length >= 4) {
          searchConditions.push({ binding_code: `3KS-${digitsOnly}` });
          searchConditions.push({ binding_code: { [Op.like]: `%${digitsOnly}%` } });
          searchConditions.push({ reference_number: { [Op.like]: `%${digitsOnly}%` } });
        }

        if (digitsOnly.length >= 10) {
          searchConditions.push({ user_contact: { [Op.like]: `%${digitsOnly}%` } });
        }

        const reservation = await Reservation.findOne({
          where: { [Op.or]: searchConditions },
          order: [['id', 'DESC']],
          include: [{ model: Court, as: 'court' }]
        });

        if (reservation) {
          console.log(`[FB Webhook] Binding reservation ${reservation.reference_number} to PSID ${senderId}...`);
          reservation.fb_psid = senderId;
          await reservation.save();

          try {
            const io = getIO();
            io.emit('player_messenger_bound', {
              reference: reservation.reference_number,
              psid: senderId
            });
          } catch (e) {}

          const replyText = `✅ [3KS PLAYGROUND] Connected!\n\n` +
            `Hello ${reservation.user_name}! Your Facebook Messenger is now linked to Reservation #${reservation.reference_number}.\n\n` +
            `📅 Date: ${reservation.reservation_date} (${reservation.start_time})\n` +
            `🏟️ Court: ${reservation.court ? reservation.court.display_name : 'Court ' + reservation.court_id}\n\n` +
            `You will receive instant pass & confirmation alerts here! 🏓`;

          await sendMessengerNotify(senderId, replyText);
        } else {
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
  processAdminAction,
  handleWebhookVerification,
  handleWebhookEvents,
  getAllAdminPsids,
  getSetting
};
