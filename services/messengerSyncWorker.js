const { Reservation, Court, SystemSetting } = require('../models');
const { Op } = require('sequelize');
const { getIO } = require('../config/socket');
const { sendMessengerNotify, getSetting } = require('./facebookService');

let syncInterval = null;
const processedMessageIds = new Set();

async function checkAndSyncMessengerInbox() {
  try {
    const pageToken = await getSetting('fb_page_token');
    const pageId = await getSetting('fb_page_id') || '1224751467396635';

    if (!pageToken || !pageId) return;

    const url = `https://graph.facebook.com/v24.0/${pageId}/conversations?fields=id,updated_time,snippet,messages{message,created_time,from}&access_token=${pageToken}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) return;

    for (const conv of data.data) {
      const messages = conv.messages && conv.messages.data ? conv.messages.data : [];
      for (const msg of messages) {
        if (!msg.id || processedMessageIds.has(msg.id)) continue;
        processedMessageIds.add(msg.id);

        // Keep set size manageable
        if (processedMessageIds.size > 500) {
          const firstKey = processedMessageIds.values().next().value;
          processedMessageIds.delete(firstKey);
        }

        // Ignore messages sent by the page itself
        if (!msg.from || msg.from.id === pageId) continue;

        const senderId = msg.from.id;
        const senderName = msg.from.name || 'Player';
        const text = (msg.message || '').trim().toUpperCase();

        if (!text) continue;

        const compactText = text.replace(/\s+/g, '').replace(/–|—/g, '-');
        const digitsOnly = text.replace(/\D/g, '');

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

        if (reservation && reservation.fb_psid !== senderId) {
          console.log(`[Messenger Sync] Binding reservation ${reservation.reference_number} (Code: ${reservation.binding_code}) to ${senderName} (PSID: ${senderId})...`);
          reservation.fb_psid = senderId;
          await reservation.save();

          // Real-time broadcast to browser
          try {
            const io = getIO();
            io.emit('player_messenger_bound', {
              reference: reservation.reference_number,
              psid: senderId
            });
          } catch (e) {}

          // Reply in Messenger
          const replyText = `✅ [3KS PLAYGROUND] Connected!\n\n` +
            `Hello ${senderName}! Your Facebook Messenger is now linked to Reservation #${reservation.reference_number}.\n\n` +
            `📅 Date: ${reservation.reservation_date} (${reservation.start_time})\n` +
            `🏟️ Court: ${reservation.court ? reservation.court.display_name : 'Court ' + reservation.court_id}\n\n` +
            `You will receive instant pass & confirmation alerts here! 🏓`;

          await sendMessengerNotify(senderId, replyText);
        }
      }
    }
  } catch (err) {
    // console.warn('[Messenger Sync Worker Error]:', err.message);
  }
}

function startMessengerSyncWorker() {
  if (syncInterval) return;
  // Run once on startup after 3 seconds, then every 5 seconds
  setTimeout(checkAndSyncMessengerInbox, 3000);
  syncInterval = setInterval(checkAndSyncMessengerInbox, 5000);
  console.log('[Worker] Messenger Real-time Sync Worker active (5s interval).');
}

function stopMessengerSyncWorker() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = { startMessengerSyncWorker, stopMessengerSyncWorker };
