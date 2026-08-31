const { SystemSetting } = require('../models');

const FB_VERSION = 'v19.0';

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
        message: messageBody,
        messaging_type: 'MESSAGE_TAG',
        tag: 'CONFIRMED_EVENT_UPDATE'
      })
    });

    const data = await response.json();
    if (data.error) {
      console.error('[FB Messenger Error]:', data.error.message);
      return false;
    }
    console.log('[FB Service] Notification sent successfully to PSID:', psid);
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

module.exports = {
  sendMessengerNotify,
  fetchUserPages,
  notifyAdminNewBooking,
  notifyAdminPaymentProof,
  getSetting
};
