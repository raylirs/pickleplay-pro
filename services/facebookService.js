const { SystemSetting, Reservation, Court, User } = require('../models');
const { getIO } = require('../config/socket');
const { Op } = require('sequelize');

const FB_VERSION = 'v24.0';

// Queue for alerts blocked by Meta's 24-hour standard messaging window (auto-flushed as soon as recipient messages the Page)
const pendingMessengerQueue = new Map(); // psid -> Array<{ payload, queuedAt }>
// Track last known user interaction timestamp per PSID
const lastUserInteractionMap = new Map(); // psid -> timestamp (ms)
const keepAliveSentMap = new Map(); // psid -> timestamp (ms)

function enqueuePendingMessage(psid, payload) {
  const cleanPsid = String(psid).trim();
  if (!pendingMessengerQueue.has(cleanPsid)) {
    pendingMessengerQueue.set(cleanPsid, []);
  }
  const list = pendingMessengerQueue.get(cleanPsid);
  // Keep max 15 recent alerts per recipient
  if (list.length >= 15) {
    list.shift();
  }
  list.push({ payload, queuedAt: Date.now() });
}

/**
 * Flush any queued alerts for a PSID once their 24-hour window reopens
 */
async function flushPendingMessages(psid) {
  const cleanPsid = String(psid).trim();
  const list = pendingMessengerQueue.get(cleanPsid);
  if (!list || list.length === 0) return 0;

  pendingMessengerQueue.delete(cleanPsid);
  let sentCount = 0;
  for (const item of list) {
    const res = await sendMessengerNotify(cleanPsid, item.payload, { skipQueueOnWindowError: true });
    if (res && res.success) {
      sentCount++;
    }
  }
  return sentCount;
}

function recordUserInteraction(psid, timestampMs = Date.now()) {
  if (!psid) return;
  const cleanPsid = String(psid).trim();
  const prev = lastUserInteractionMap.get(cleanPsid) || 0;
  if (timestampMs > prev) {
    lastUserInteractionMap.set(cleanPsid, timestampMs);
    keepAliveSentMap.delete(cleanPsid);
  }
}

function getWindowStatusForPsid(psid) {
  const cleanPsid = String(psid || '').trim();
  const lastMs = lastUserInteractionMap.get(cleanPsid) || 0;
  const ageMs = Date.now() - lastMs;
  const windowOpen = lastMs > 0 && ageMs < 24 * 60 * 60 * 1000;
  const queuedCount = (pendingMessengerQueue.get(cleanPsid) || []).length;
  return {
    psid: cleanPsid,
    lastInteractionAt: lastMs ? new Date(lastMs).toISOString() : null,
    windowOpen,
    hoursRemaining: windowOpen ? Math.max(0, ((24 * 60 * 60 * 1000 - ageMs) / (60 * 60 * 1000)).toFixed(1)) : 0,
    queuedCount
  };
}

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
async function sendMessengerNotify(psid, payload, options = {}) {
  const token = await getSetting('fb_page_token');
  if (!token) {
    console.log('[FB Service] Page access token is missing in settings.');
    return { success: false, error: 'Page access token is missing in Facebook settings.' };
  }
  if (!psid) {
    console.log('[FB Service] PSID missing, skipping FB notification.');
    return { success: false, error: 'Recipient PSID is missing.' };
  }

  try {
    const cleanPsid = String(psid).trim();
    const url = `https://graph.facebook.com/${FB_VERSION}/me/messages?access_token=${token}`;
    let messageBody = typeof payload === 'string' ? { text: payload } : payload;

    const isTagged = options.tag || options.useTag;
    const requestBody = {
      recipient: { id: cleanPsid },
      messaging_type: isTagged ? 'MESSAGE_TAG' : 'RESPONSE',
      ...(isTagged ? { tag: options.tag || 'CONFIRMED_EVENT_UPDATE' } : {}),
      message: messageBody
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (data.error) {
      const errCode = data.error.code;
      const errMsg = data.error.message || 'Unknown Meta Graph API error';
      console.error('[FB Messenger Error]:', errMsg);

      // If template/button payload failed (e.g. invalid URL or unsupported attachment), fallback to plain text if possible
      if (typeof payload === 'object' && payload.attachment && payload.attachment.payload && payload.attachment.payload.text && errCode !== 10) {
        const fallbackText = payload.attachment.payload.text +
          `\n\n✅ Reply "APPROVE" or "DECLINE" in Messenger, or manage at: https://pickleplay-pro.onrender.com/admin/reservations`;
        return await sendMessengerNotify(cleanPsid, fallbackText, options);
      }

      // Meta 24-Hour Messaging Window Policy (#10) - Try with MESSAGE_TAG first
      if (errCode === 10 || errMsg.toLowerCase().includes('outside of allowed window')) {
        if (!options.isTagRetry) {
          console.log(`[FB Service] PSID ${cleanPsid} outside 24h window. Retrying with CONFIRMED_EVENT_UPDATE tag...`);
          const tagRetry = await sendMessengerNotify(cleanPsid, payload, { ...options, useTag: true, isTagRetry: true });
          if (tagRetry && tagRetry.success) {
            return tagRetry;
          }
        }

        if (!options.skipQueueOnWindowError) {
          enqueuePendingMessage(cleanPsid, payload);
          console.log(`[FB Service] Queued alert for PSID ${cleanPsid} (will auto-deliver as soon as recipient sends any message to the Page).`);
        }
        try {
          const io = getIO();
          io.emit('fb_window_expired', {
            psid: cleanPsid,
            pageId: (await getSetting('fb_page_id')) || '1224751467396635',
            error: '24-hour Messenger window expired. Send "ACTIVATE" or "Hi" to The Playground Pickleball on Messenger to reopen instant alerts.'
          });
        } catch (e) {}

        return {
          success: false,
          windowExpired: true,
          error: 'Meta 24-hour messaging window expired for this recipient. Open Messenger with "The Playground Pickleball" (m.me/1224751467396635) and send "Hi" or "ACTIVATE" to reopen instant alerts (queued alerts will deliver automatically within 5 seconds).'
        };
      }

      return { success: false, error: errMsg };
    }
    console.log('[FB Service] Message delivered to PSID:', cleanPsid, 'ID:', data.message_id);
    return { success: true, messageId: data.message_id };
  } catch (error) {
    console.error('[FB Messenger Service Error]:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch all Facebook Pages for a user using User Access Token or Page Access Token
 */
async function fetchUserPages(token) {
  if (!token) throw new Error('Access token is required');
  const cleanToken = token.trim();
  const fields = 'id,name,access_token,category,picture{url}';

  // 1. Try fetching via /me/accounts (works when given a User Access Token)
  try {
    const response = await fetch(`https://graph.facebook.com/${FB_VERSION}/me/accounts?fields=${fields}&access_token=${cleanToken}`);
    const data = await response.json();
    if (!data.error && Array.isArray(data.data) && data.data.length > 0) {
      return data.data;
    }
  } catch (err) {
    // Continue to Page token fallback
  }

  // 2. If token is a Page Access Token, /me/accounts fails. Query /me directly for the Page
  try {
    const pageRes = await fetch(`https://graph.facebook.com/${FB_VERSION}/me?fields=id,name,category,picture{url}&access_token=${cleanToken}`);
    const pageData = await pageRes.json();
    if (pageData && pageData.id && pageData.name) {
      return [{
        id: pageData.id,
        name: pageData.name,
        access_token: cleanToken,
        category: pageData.category || 'Facebook Page',
        picture: pageData.picture
      }];
    }
    if (pageData && pageData.error) {
      throw new Error(pageData.error.message);
    }
  } catch (err) {
    throw new Error(err.message || 'Failed to authenticate token with Meta API');
  }

  return [];
}

/**
 * Helper to get all Admin PSIDs (respects Ryan & Karlo mute toggles + includes any admin accounts with fb_psid)
 */
async function getAllAdminPsids() {
  const raw = await getSetting('fb_admin_psid');
  const ryanActive = (await getSetting('fb_admin_ryan_active')) !== 'false';
  const karloActive = (await getSetting('fb_admin_karlo_active')) !== 'false';
  const activePsids = [];

  if (raw) {
    const parsed = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    for (const p of parsed) {
      if (p === '27030144379994794' && !ryanActive) continue;
      if (p === '38090624017219189' && !karloActive) continue;
      if (!activePsids.includes(p)) {
        activePsids.push(p);
      }
    }
  } else {
    if (ryanActive) activePsids.push('27030144379994794');
    if (karloActive) activePsids.push('38090624017219189');
  }

  // Also include any User with role='admin' who has bound their fb_psid
  try {
    const adminUsers = await User.findAll({
      where: {
        role: 'admin',
        fb_psid: { [Op.ne]: null }
      }
    });
    for (const u of adminUsers) {
      const p = String(u.fb_psid || '').trim();
      if (!p) continue;
      if (p === '27030144379994794' && !ryanActive) continue;
      if (p === '38090624017219189' && !karloActive) continue;
      if (!activePsids.includes(p)) {
        activePsids.push(p);
      }
    }
  } catch (e) {}

  return activePsids;
}

/**
 * Notify Admin when a new booking is submitted (with 1-Click Interactive Buttons)
 */
async function notifyAdminNewBooking(reservation, extra = {}) {
  const adminPsids = await getAllAdminPsids();
  if (!adminPsids || adminPsids.length === 0) return;

  const courtLabel = extra.courtSummary || (reservation.court ? reservation.court.display_name : `Court ${reservation.court_id}`);
  const totalAmount = extra.totalAmount !== undefined ? parseFloat(extra.totalAmount) : parseFloat(reservation.total_amount || 0);
  const timeRange = reservation.end_time ? `${reservation.start_time} - ${reservation.end_time}` : reservation.start_time;

  const text = `🔔 [THE PLAYGROUND] NEW BOOKING RECEIVED (AWAITING PAYMENT)\n\n` +
    `📋 Ref: ${reservation.reference_number}\n` +
    `👤 Player: ${reservation.user_name} (${reservation.user_contact})\n` +
    `🏟️ Court: ${courtLabel} | 📅 ${reservation.reservation_date}\n` +
    `⏰ Time: ${timeRange}\n` +
    `💰 Total: ₱${totalAmount.toFixed(2)}\n\n` +
    `⏳ Status: Player has a 15-minute hold to upload GCash payment proof. You will receive an approval alert once payment proof is submitted.`;

  const buttonPayload = {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: [
          {
            type: 'web_url',
            url: 'https://pickleplay-pro.onrender.com/admin/reservations',
            title: 'View in Admin'
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
 * Notify Admin when a GCash payment proof is submitted (with Screenshot Image & 1-Click Interactive Buttons)
 */
async function notifyAdminPaymentProof(reservation) {
  const adminPsids = await getAllAdminPsids();
  if (!adminPsids || adminPsids.length === 0) return;

  const baseUrl = process.env.APP_URL && process.env.APP_URL.startsWith('https://')
    ? process.env.APP_URL.replace(/\/$/, '')
    : 'https://pickleplay-pro.onrender.com';

  // 1. If screenshot is uploaded and publicly accessible via HTTPS, attempt to send image attachment
  if (reservation.payment_screenshot) {
    const screenshotUrl = reservation.payment_screenshot.startsWith('http')
      ? reservation.payment_screenshot
      : `${baseUrl}${reservation.payment_screenshot}`;

    const imagePayload = {
      attachment: {
        type: 'image',
        payload: {
          url: screenshotUrl,
          is_reusable: true
        }
      }
    };

    for (const psid of adminPsids) {
      // Do not queue failed local image attachments if running on localhost
      await sendMessengerNotify(psid, imagePayload, { skipQueueOnWindowError: true }).catch(() => {});
    }
  }

  // Compute total order amount across sibling courts if multi-court
  let totalOrderAmount = parseFloat(reservation.total_amount || 0);
  try {
    const masterRef = (reservation.reference_number || '').split('-')[0];
    const siblings = await Reservation.findAll({
      where: {
        reference_number: {
          [Op.or]: [masterRef, { [Op.like]: `${masterRef}-%` }]
        }
      }
    });
    if (siblings && siblings.length > 0) {
      totalOrderAmount = siblings.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);
    }
  } catch (e) {}

  // 2. Send transaction details and 1-Click Action Buttons
  const text = `💳 [THE PLAYGROUND] GCASH PROOF SUBMITTED!\n\n` +
    `📋 Ref: ${reservation.reference_number}\n` +
    `👤 Player: ${reservation.user_name}\n` +
    `🧾 GCash Ref: ${reservation.gcash_reference_no || 'Attached Screenshot'}\n` +
    `💰 Amount: ₱${totalOrderAmount.toFixed(2)}`;

  const buttonPayload = {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: [
          {
            type: 'postback',
            title: 'Approve',
            payload: `APPROVE_${reservation.reference_number}`
          },
          {
            type: 'postback',
            title: 'Decline',
            payload: `CANCEL_${reservation.reference_number}`
          },
          {
            type: 'web_url',
            url: `${baseUrl}/admin/reservations`,
            title: 'View Booking'
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
 * Helper to resolve Player's FB PSID from reservation or User record
 */
async function resolvePlayerPsid(reservation) {
  if (!reservation) return null;
  if (reservation.fb_psid) return String(reservation.fb_psid).trim();
  if (reservation.user_id) {
    try {
      const playerUser = await User.findByPk(reservation.user_id);
      if (playerUser && playerUser.fb_psid) {
        return String(playerUser.fb_psid).trim();
      }
    } catch (e) {}
  }
  if (reservation.user_contact) {
    try {
      const matchedUser = await User.findOne({ where: { phone: reservation.user_contact } });
      if (matchedUser && matchedUser.fb_psid) {
        return String(matchedUser.fb_psid).trim();
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Notify Player when they create a new booking (AWAITING_PAYMENT hold)
 */
async function notifyPlayerNewBooking(reservation, extra = {}) {
  const targetPsid = await resolvePlayerPsid(reservation);
  if (!targetPsid) return;

  const courtLabel = extra.courtSummary || (reservation.court ? reservation.court.display_name : `Court ${reservation.court_id}`);
  const totalAmount = extra.totalAmount !== undefined ? parseFloat(extra.totalAmount) : parseFloat(reservation.total_amount || 0);
  const timeRange = reservation.end_time ? `${reservation.start_time} - ${reservation.end_time}` : reservation.start_time;

  const msg = `🏓 [THE PLAYGROUND] BOOKING CREATED (AWAITING PAYMENT)\n\n` +
    `Hello ${reservation.user_name}! Your court slot is held for 15 minutes while awaiting GCash payment proof.\n\n` +
    `📋 Ref: ${reservation.reference_number}\n` +
    `🏟️ Court: ${courtLabel}\n` +
    `📅 Date: ${reservation.reservation_date}\n` +
    `⏰ Time: ${timeRange}\n` +
    `💰 Total Due: ₱${totalAmount.toFixed(2)}\n\n` +
    `👉 Complete GCash Payment: https://pickleplay-pro.onrender.com/payment/gcash?ref=${reservation.reference_number}`;

  await sendMessengerNotify(targetPsid, msg);
}

/**
 * Notify Player when their GCash payment proof is submitted
 */
async function notifyPlayerPaymentSubmitted(reservation, totalOrderAmount) {
  const targetPsid = await resolvePlayerPsid(reservation);
  if (!targetPsid) return;

  const amountVal = totalOrderAmount !== undefined ? parseFloat(totalOrderAmount) : parseFloat(reservation.total_amount || 0);
  const msg = `🧾 [THE PLAYGROUND] GCASH PROOF RECEIVED!\n\n` +
    `Hello ${reservation.user_name}! We received your GCash payment proof for Booking #${reservation.reference_number}.\n\n` +
    `🧾 GCash Ref: ${reservation.gcash_reference_no || 'Submitted'}\n` +
    `💰 Amount: ₱${amountVal.toFixed(2)}\n` +
    `⏳ Status: Verifying Payment\n\n` +
    `You will receive your confirmed digital pass here as soon as Admin verifies your payment! 🏓`;

  await sendMessengerNotify(targetPsid, msg);
}

/**
 * Notify Player when their booking is CONFIRMED by Admin
 */
async function notifyPlayerBookingConfirmed(reservation) {
  const targetPsid = await resolvePlayerPsid(reservation);
  if (!targetPsid) return;

  const msg = `🎉 [THE PLAYGROUND] YOUR BOOKING IS CONFIRMED!\n\n` +
    `Hello ${reservation.user_name}! Your court reservation has been verified and confirmed by Admin.\n\n` +
    `📋 Booking Ref: ${reservation.reference_number}\n` +
    `🏟️ Court: Court ${reservation.court_id}\n` +
    `📅 Date: ${reservation.reservation_date}\n` +
    `⏰ Time: ${reservation.start_time}\n` +
    `💰 Amount Paid: ₱${parseFloat(reservation.total_amount).toFixed(2)}\n\n` +
    `🎟️ View Your Digital Pass: https://pickleplay-pro.onrender.com/reservations/${reservation.reference_number}\n\n` +
    `See you on the court! 🏓`;

  await sendMessengerNotify(targetPsid, msg);
}

/**
 * Notify Player when their booking is CANCELLED by Admin
 */
async function notifyPlayerBookingCancelled(reservation) {
  const targetPsid = await resolvePlayerPsid(reservation);
  if (!targetPsid) return;

  const reason = reservation.cancellation_reason || 'Cancelled by Administrator';
  const msg = `⚠️ [THE PLAYGROUND] BOOKING CANCELLED (#${reservation.reference_number})\n\n` +
    `Hello ${reservation.user_name || 'Player'}, your reservation on ${reservation.reservation_date} (${reservation.start_time}) has been cancelled.\n` +
    `📝 Reason: ${reason}\n\n` +
    `Visit https://pickleplay-pro.onrender.com to book another court time or message us here if you need assistance.`;

  await sendMessengerNotify(targetPsid, msg);
}

/**
 * Notify Player when their unpaid 15-minute hold expires and is automatically cancelled
 */
async function notifyPlayerHoldExpired(reservation) {
  const targetPsid = await resolvePlayerPsid(reservation);
  if (!targetPsid) return;

  const masterRef = (reservation.reference_number || '').split('-')[0];
  const msg = `⏰ [THE PLAYGROUND] UNPAID HOLD CANCELLED (#${masterRef})\n\n` +
    `Hello ${reservation.user_name || 'Player'}, your 15-minute reservation hold on ${reservation.reservation_date} (${reservation.start_time}) has timed out without GCash payment proof and was automatically cancelled.\n\n` +
    `The court slot has been released back to the schedule. Visit https://pickleplay-pro.onrender.com anytime to book a new slot! 🏓`;

  await sendMessengerNotify(targetPsid, msg);
}

/**
 * Send Admin Alert Hub confirmation card (with 1-tap Keep-Alive button)
 */
async function sendAdminStatusCard(senderId, extraNote = '') {
  const pendingCount = await Reservation.count({
    where: { status: { [Op.in]: ['AWAITING_CONFIRMATION', 'AWAITING_PAYMENT', 'PENDING'] } }
  });

  const text = `✅ [THE PLAYGROUND] ADMIN ALERTS ACTIVE!\n\n` +
    (extraNote ? `${extraNote}\n\n` : '') +
    `🟢 Your 24-hour Meta Messenger alert window is now OPEN.\n` +
    `📋 Active Pending Bookings: ${pendingCount}\n\n` +
    `💡 Tip: Tap "Keep Alerts Active" anytime to reset your 24h alert window.`;

  const payload = {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: [
          {
            type: 'postback',
            title: 'Keep Alerts Active',
            payload: 'KEEP_ALERTS_ACTIVE'
          },
          {
            type: 'web_url',
            url: 'https://pickleplay-pro.onrender.com/admin/reservations',
            title: 'Admin Dashboard'
          }
        ]
      }
    }
  };

  return await sendMessengerNotify(senderId, payload, { skipQueueOnWindowError: true });
}

/**
 * Process Admin 1-Click Action (Confirm, Cancel, or Keep-Alive via Messenger buttons/messages)
 */
async function processAdminAction(senderId, rawText, contextRef = null) {
  const adminPsids = await getAllAdminPsids();
  const isDefaultAdmin = senderId === '27030144379994794' || senderId === '38090624017219189';
  if (!adminPsids.includes(senderId) && !isDefaultAdmin) return false;

  recordUserInteraction(senderId, Date.now());
  const flushedCount = await flushPendingMessages(senderId);

  const upper = (rawText || '').trim().toUpperCase();

  // Check if Admin tapped Keep-Alive or sent an activation keyword
  if (
    upper === 'KEEP_ALERTS_ACTIVE' ||
    upper === 'KEEP ALERTS ACTIVE' ||
    upper === 'ACTIVATE' ||
    upper === 'ACTIVATE_ALERTS' ||
    upper === 'PING' ||
    upper === 'STATUS' ||
    upper === 'TEST' ||
    upper === 'HI' ||
    upper === 'HELLO' ||
    upper === 'YOW'
  ) {
    const flushedNote = flushedCount > 0 ? `📬 Delivered ${flushedCount} queued booking alert(s)!` : '';
    await sendAdminStatusCard(senderId, flushedNote);
    return true;
  }

  const isApprove =
    upper === 'APPROVE' ||
    upper === 'CONFIRM' ||
    upper.startsWith('APPROVE_') ||
    upper.startsWith('CONFIRM_') ||
    upper.startsWith('APPROVE ') ||
    upper.startsWith('CONFIRM ');
  const isCancel =
    upper === 'CANCEL' ||
    upper === 'DECLINE' ||
    upper === 'REJECT' ||
    upper.startsWith('CANCEL_') ||
    upper.startsWith('DECLINE_') ||
    upper.startsWith('REJECT_') ||
    upper.startsWith('CANCEL ') ||
    upper.startsWith('DECLINE ') ||
    upper.startsWith('REJECT ');

  if (!isApprove && !isCancel) return false;

  let refMatch = upper
    .replace(/^(APPROVE_|CONFIRM_|CANCEL_|DECLINE_|REJECT_|APPROVE\s+|CONFIRM\s+|CANCEL\s+|DECLINE\s+|REJECT\s+|APPROVE|CONFIRM|CANCEL|DECLINE|REJECT)/, '')
    .replace(/^#/, '')
    .trim();

  if (!refMatch && contextRef) {
    refMatch = String(contextRef).trim().toUpperCase();
  }

  const { getCourtAvailability } = require('./availabilityService');

  let reservation = null;
  if (refMatch) {
    reservation = await Reservation.findOne({
      where: {
        [Op.or]: [
          { reference_number: refMatch },
          { reference_number: { [Op.like]: `%${refMatch}%` } },
          { binding_code: refMatch },
          { binding_code: { [Op.like]: `%${refMatch}%` } }
        ]
      },
      include: [{ model: Court, as: 'court' }],
      order: [['id', 'DESC']]
    });
  } else {
    // Fallback to the latest reservation awaiting confirmation/payment
    reservation = await Reservation.findOne({
      where: {
        status: { [Op.in]: ['AWAITING_CONFIRMATION', 'AWAITING_PAYMENT', 'PENDING'] }
      },
      include: [{ model: Court, as: 'court' }],
      order: [['updated_at', 'DESC'], ['id', 'DESC']]
    });
  }

  if (!reservation) {
    await sendMessengerNotify(senderId, `⚠️ Reservation ${refMatch ? '"' + refMatch + '" ' : ''}not found or no pending bookings to process.`);
    return true;
  }

  const masterRef = reservation.reference_number.split('-')[0];
  const allSiblings = await Reservation.findAll({
    where: {
      reference_number: {
        [Op.or]: [masterRef, { [Op.like]: `${masterRef}-%` }]
      }
    },
    include: [{ model: Court, as: 'court' }]
  });

  if (isApprove) {
    const txId = `MESSENGER-1CLICK-${Date.now()}`;
    for (const resv of allSiblings) {
      resv.status = 'CONFIRMED';
      resv.payment_transaction_id = txId;
      await resv.save();

      try {
        const io = getIO();
        const avail = await getCourtAvailability(resv.court_id, resv.reservation_date);
        io.emit('court_availability_updated', {
          courtId: resv.court_id,
          date: resv.reservation_date,
          slots: avail.slots
        });
        io.emit('payment_confirmed', {
          reference: resv.reference_number,
          courtId: resv.court_id
        });
      } catch (e) {}
    }

    // Send confirmed pass to player if bound
    await notifyPlayerBookingConfirmed(reservation);

    try {
      const { postBookingSystemMessage } = require('./chatService');
      await postBookingSystemMessage(reservation, 'BOOKING_CONFIRMED');
    } catch (e) {}

    await sendMessengerNotify(senderId, `🎉 [1-CLICK APPROVED] Reservation #${masterRef} for ${reservation.user_name} is now CONFIRMED!\n\nPlayer has been sent their confirmed digital pass on Messenger & In-App Chat.`);
    return true;
  }

  if (isCancel) {
    for (const resv of allSiblings) {
      resv.status = 'CANCELLED';
      resv.cancellation_reason = 'Cancelled by Admin via 1-Click Messenger';
      await resv.save();

      try {
        const io = getIO();
        const avail = await getCourtAvailability(resv.court_id, resv.reservation_date);
        io.emit('court_availability_updated', {
          courtId: resv.court_id,
          date: resv.reservation_date,
          slots: avail.slots
        });
      } catch (e) {}
    }

    try {
      const { postBookingSystemMessage } = require('./chatService');
      await postBookingSystemMessage(reservation, 'BOOKING_CANCELLED');
    } catch (e) {}

    await notifyPlayerBookingCancelled(reservation);

    await sendMessengerNotify(senderId, `❌ [1-CLICK CANCELLED] Reservation #${masterRef} has been cancelled and slots released.`);
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
      recordUserInteraction(senderId, Date.now());
      await flushPendingMessages(senderId);

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
        // 1. Check if this is an Admin 1-Click Approve/Cancel/Keep-Alive action
        const handledAdmin = await processAdminAction(senderId, incomingText);
        if (handledAdmin) continue;

        // 2. Check for Player Account or Booking Binding
        const cleanedText = incomingText.trim().toUpperCase();
        const compactText = cleanedText.replace(/\s+/g, '').replace(/–|—/g, '-');
        const digitsOnly = incomingText.replace(/\D/g, '');

        // 2a. Check Player User Account first (by account binding_code, phone, or email)
        const userConditions = [
          { binding_code: compactText },
          { email: incomingText.trim().toLowerCase() }
        ];
        if (digitsOnly.length >= 4) {
          userConditions.push({ binding_code: `PLAY-${digitsOnly}` });
          userConditions.push({ binding_code: { [Op.like]: `%${digitsOnly}%` } });
        }
        if (digitsOnly.length >= 10) {
          userConditions.push({ phone: { [Op.like]: `%${digitsOnly.slice(-10)}%` } });
        }

        const matchedUser = await User.findOne({
          where: { [Op.or]: userConditions },
          order: [['id', 'DESC']]
        });

        if (matchedUser) {
          matchedUser.fb_psid = senderId;
          await matchedUser.save();

          await Reservation.update(
            { fb_psid: senderId },
            {
              where: {
                [Op.or]: [
                  { user_id: matchedUser.id },
                  ...(matchedUser.phone ? [{ user_contact: matchedUser.phone }] : [])
                ]
              }
            }
          );

          try {
            const io = getIO();
            io.emit('player_messenger_bound', {
              userId: matchedUser.id,
              bindingCode: matchedUser.binding_code,
              psid: senderId
            });
          } catch (e) {}

          const replyText = `✅ [THE PLAYGROUND] Account Connected!\n\n` +
            `Hello ${matchedUser.full_name || matchedUser.username}! Your Facebook Messenger is now linked to your Player Account (${matchedUser.phone || matchedUser.username}).\n\n` +
            `You will automatically receive instant digital passes and booking confirmation alerts here for all your court reservations! 🏓`;

          await sendMessengerNotify(senderId, replyText);
          continue;
        }

        // 2b. Fallback: Check individual Reservation reference/binding_code
        const searchConditions = [
          { reference_number: compactText },
          { binding_code: compactText },
          { reference_number: { [Op.like]: `%${compactText}%` } },
          { binding_code: { [Op.like]: `%${compactText}%` } }
        ];

        if (digitsOnly.length >= 4) {
          searchConditions.push({ binding_code: `PLAY-${digitsOnly}` });
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

          if (reservation.user_id) {
            await User.update({ fb_psid: senderId }, { where: { id: reservation.user_id } });
          }

          try {
            const io = getIO();
            io.emit('player_messenger_bound', {
              userId: reservation.user_id || null,
              reference: reservation.reference_number,
              psid: senderId
            });
          } catch (e) {}

          const replyText = `✅ [THE PLAYGROUND] Connected!\n\n` +
            `Hello ${reservation.user_name}! Your Facebook Messenger is now linked to your account & Reservation #${reservation.reference_number}.\n\n` +
            `📅 Date: ${reservation.reservation_date} (${reservation.start_time})\n` +
            `🏟️ Court: ${reservation.court ? reservation.court.display_name : 'Court ' + reservation.court_id}\n\n` +
            `You will receive instant pass & confirmation alerts here! 🏓`;

          await sendMessengerNotify(senderId, replyText);
        } else {
          const adminPsids = await getAllAdminPsids();
          if (adminPsids.includes(senderId)) {
            await sendAdminStatusCard(senderId);
          } else {
            const alreadyBoundUser = await User.findOne({ where: { fb_psid: senderId } });
            if (alreadyBoundUser) {
              await sendMessengerNotify(
                senderId,
                `🏓 [THE PLAYGROUND] Hi ${alreadyBoundUser.full_name || alreadyBoundUser.username}! Your Messenger alerts are active and linked to your account (${alreadyBoundUser.binding_code || alreadyBoundUser.phone}).\n\n🌐 Book or view passes: https://pickleplay-pro.onrender.com`
              );
            } else {
              const helpText = `👋 Hello! Welcome to The Playground Pickleball.\n\n` +
                `To link your Player Account for Messenger alerts, reply with your Account Code (e.g. PLAY-1234) or your registered mobile number.\n\n` +
                `🌐 Book online: https://pickleplay-pro.onrender.com`;
              await sendMessengerNotify(senderId, helpText);
            }
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
  notifyPlayerNewBooking,
  notifyPlayerPaymentSubmitted,
  notifyPlayerBookingConfirmed,
  notifyPlayerBookingCancelled,
  notifyPlayerHoldExpired,
  processAdminAction,
  sendAdminStatusCard,
  flushPendingMessages,
  recordUserInteraction,
  getWindowStatusForPsid,
  keepAliveSentMap,
  handleWebhookVerification,
  handleWebhookEvents,
  getAllAdminPsids,
  getSetting
};
