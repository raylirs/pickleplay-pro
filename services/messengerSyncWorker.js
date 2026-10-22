const { Reservation, Court, User } = require('../models');
const { Op } = require('sequelize');
const { getIO } = require('../config/socket');
const {
  sendMessengerNotify,
  getSetting,
  getAllAdminPsids,
  processAdminAction,
  sendAdminStatusCard,
  flushPendingMessages,
  recordUserInteraction,
  getWindowStatusForPsid,
  keepAliveSentMap
} = require('./facebookService');

let syncInterval = null;
let isInitialized = false;
const processedMessageIds = new Set();

async function checkAndSyncMessengerInbox() {
  try {
    const pageToken = await getSetting('fb_page_token');
    const pageId = (await getSetting('fb_page_id')) || '1224751467396635';

    if (!pageToken || !pageId) return;

    const url = `https://graph.facebook.com/v24.0/${pageId}/conversations?fields=id,updated_time,snippet,messages.limit(10){message,created_time,from}&access_token=${pageToken}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) return;

    for (const conv of data.data) {
      const messages = conv.messages && Array.isArray(conv.messages.data) ? conv.messages.data : [];
      if (messages.length === 0) continue;

      // 1. Update last known user interaction timestamp for this conversation's user
      for (const m of messages) {
        if (m.from && m.from.id && m.from.id !== pageId && m.created_time) {
          const ts = new Date(m.created_time).getTime();
          if (!isNaN(ts)) {
            recordUserInteraction(m.from.id, ts);
          }
          break; // messages are newest-first, so the first non-page message is the user's latest interaction
        }
      }

      // 2. Find the index of the latest message sent by the Page itself
      // Any user message older than the Page's latest message has already been answered
      let latestPageMsgIndex = -1;
      let latestPageRefContext = null;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.from && m.from.id === pageId) {
          if (latestPageMsgIndex === -1) {
            latestPageMsgIndex = i;
          }
          if (!latestPageRefContext && m.message) {
            // Ignore bot's own success / completion replies to prevent matching old reservations
            const isCompletionReply = /APPROVED|CONFIRMED|CANCELLED|DECLINED|ALERTS ACTIVE|STATUS|PASS/i.test(m.message);
            if (!isCompletionReply) {
              const refMatch = m.message.match(/Ref:\s*([A-Za-z0-9-]+)/i);
              if (refMatch && refMatch[1]) {
                latestPageRefContext = refMatch[1].trim();
              }
            }
          }
        }
      }

      // On first boot pass, mark all older messages as processed; only process an unanswered message if it arrived within the last 2 minutes
      if (!isInitialized) {
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (!m.id) continue;
          const msgAgeMs = m.created_time ? (Date.now() - new Date(m.created_time).getTime()) : Infinity;
          const isUnansweredRecent = (latestPageMsgIndex === -1 || i < latestPageMsgIndex) && msgAgeMs < 2 * 60 * 1000;
          if (!isUnansweredRecent) {
            processedMessageIds.add(m.id);
          }
        }
      }

      // 3. Process only unanswered user messages (those at index < latestPageMsgIndex, or all if Page never replied)
      const unansweredSlice = latestPageMsgIndex === -1 ? messages : messages.slice(0, latestPageMsgIndex);
      // Process oldest-to-newest among unanswered messages
      for (const msg of unansweredSlice.slice().reverse()) {
        if (!msg.id || processedMessageIds.has(msg.id)) continue;
        processedMessageIds.add(msg.id);

        if (processedMessageIds.size > 500) {
          const firstKey = processedMessageIds.values().next().value;
          processedMessageIds.delete(firstKey);
        }

        if (!msg.from || msg.from.id === pageId) continue;

        const senderId = String(msg.from.id).trim();
        const senderName = msg.from.name || 'Player';
        const rawMessage = (msg.message || '').trim();
        const text = rawMessage.toUpperCase();

        recordUserInteraction(senderId, Date.now());
        // Immediately flush any queued alerts that were waiting for this user's 24h window to reopen
        const flushedCount = await flushPendingMessages(senderId);

        if (!text) {
          if (flushedCount > 0) {
            console.log(`[Messenger Sync] Flushed ${flushedCount} queued alert(s) to PSID ${senderId}.`);
          }
          continue;
        }

        // 3a. Process Admin 1-Click Action (Approve / Decline / Keep-Alive / Status)
        const handledAdmin = await processAdminAction(senderId, rawMessage, latestPageRefContext);
        if (handledAdmin) continue;

        const compactText = text.replace(/\s+/g, '').replace(/–|—/g, '-');
        const digitsOnly = text.replace(/\D/g, '');

        // 3b. Check Player User Account (by binding_code, phone, or email)
        const userConditions = [
          { binding_code: compactText },
          { email: rawMessage.toLowerCase() }
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
          console.log(`[Messenger Sync] Binding/Refreshing Player Account ${matchedUser.username} (Code: ${matchedUser.binding_code}) to ${senderName} (PSID: ${senderId})...`);
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
            `Hello ${matchedUser.full_name || senderName}! Your Facebook Messenger is linked to your Player Account (${matchedUser.phone || matchedUser.username}).\n\n` +
            `🟢 Your 24-hour instant alert window is active — you will receive digital passes and booking updates here! 🏓`;

          await sendMessengerNotify(senderId, replyText, { skipQueueOnWindowError: true });
          continue;
        }

        // 3c. Check Reservation reference / binding_code
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
          console.log(`[Messenger Sync] Binding/Refreshing reservation ${reservation.reference_number} to ${senderName} (PSID: ${senderId})...`);
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
            `Hello ${senderName}! Your Facebook Messenger is linked to Reservation #${reservation.reference_number}.\n\n` +
            `📅 Date: ${reservation.reservation_date} (${reservation.start_time})\n` +
            `🏟️ Court: ${reservation.court ? reservation.court.display_name : 'Court ' + reservation.court_id}\n\n` +
            `You will receive instant pass & confirmation alerts here! 🏓`;

          await sendMessengerNotify(senderId, replyText, { skipQueueOnWindowError: true });
          continue;
        }

        // 3d. If sender is an Admin or already-bound Player sending any message, confirm their active status
        const adminPsids = await getAllAdminPsids();
        if (adminPsids.includes(senderId)) {
          const flushedNote = flushedCount > 0 ? `📬 Delivered ${flushedCount} queued booking alert(s)!` : '';
          await sendAdminStatusCard(senderId, flushedNote);
        } else {
          const existingPlayer = await User.findOne({ where: { fb_psid: senderId } });
          if (existingPlayer) {
            await sendMessengerNotify(
              senderId,
              `🏓 [THE PLAYGROUND] Hi ${existingPlayer.full_name || senderName}! Your Messenger alerts are active for your account (${existingPlayer.binding_code || existingPlayer.phone}).\n\n🌐 Book or view passes: https://pickleplay-pro.onrender.com`,
              { skipQueueOnWindowError: true }
            );
          } else {
            await sendMessengerNotify(
              senderId,
              `👋 Hello ${senderName}! Welcome to The Playground Pickleball.\n\nTo link your Player Account for instant Messenger passes, reply with your Account Code (e.g. PLAY-1234) or your registered mobile number.\n\n🌐 Book online: https://pickleplay-pro.onrender.com`,
              { skipQueueOnWindowError: true }
            );
          }
        }
      }
    }

    // 4. Proactive 20-Hour Keep-Alive Ping for Admins so their 24h Meta window doesn't silently expire
    const adminPsids = await getAllAdminPsids();
    for (const adminPsid of adminPsids) {
      const status = getWindowStatusForPsid(adminPsid);
      const hoursLeft = parseFloat(status.hoursRemaining || 0);
      if (status.windowOpen && hoursLeft > 0.5 && hoursLeft <= 4.0) {
        const lastPing = keepAliveSentMap.get(adminPsid) || 0;
        if (Date.now() - lastPing > 6 * 60 * 60 * 1000) {
          keepAliveSentMap.set(adminPsid, Date.now());
          const keepAlivePayload = {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: `⏰ [THE PLAYGROUND] Your 24-hour Facebook Messenger alert window will close in ~${hoursLeft} hours.\n\nTap "Keep Alerts Active" below to keep instant booking & GCash alerts running uninterrupted! 🏓`,
                buttons: [
                  {
                    type: 'postback',
                    title: 'Keep Alerts Active',
                    payload: 'KEEP_ALERTS_ACTIVE'
                  }
                ]
              }
            }
          };
          await sendMessengerNotify(adminPsid, keepAlivePayload, { skipQueueOnWindowError: true });
        }
      }
    }

    isInitialized = true;
  } catch (err) {
    // Silent catch to keep worker polling cleanly
  }
}

function startMessengerSyncWorker() {
  if (syncInterval) return;
  setTimeout(checkAndSyncMessengerInbox, 2000);
  syncInterval = setInterval(checkAndSyncMessengerInbox, 5000);
  console.log('[Worker] Messenger Real-time Sync Worker active (5s interval).');
}

function stopMessengerSyncWorker() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = { startMessengerSyncWorker, stopMessengerSyncWorker, checkAndSyncMessengerInbox };
