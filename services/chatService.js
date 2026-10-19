const { ChatMessage, User, Reservation, Court } = require('../models');
const { Op } = require('sequelize');
const { getIO } = require('../config/socket');
const { formatTime12 } = require('../utils/dateTimeUtils');

async function resolveReservationUserId(reservation) {
  if (!reservation) return null;
  if (reservation.user_id) return reservation.user_id;

  const orConds = [];
  if (reservation.user_contact) {
    orConds.push({ phone: reservation.user_contact });
    orConds.push({ username: reservation.user_contact });
  }
  if (reservation.user_email) {
    orConds.push({ email: reservation.user_email.toLowerCase() });
  }
  if (orConds.length === 0) return null;

  const matchedUser = await User.findOne({ where: { [Op.or]: orConds } });
  if (matchedUser) {
    reservation.user_id = matchedUser.id;
    await reservation.save().catch(() => {});
    return matchedUser.id;
  }
  return null;
}

function broadcastChatMessage(chatMsg) {
  try {
    const io = getIO();
    io.emit('chat:new_message', {
      id: chatMsg.id,
      user_id: chatMsg.user_id,
      sender_role: chatMsg.sender_role,
      sender_name: chatMsg.sender_name,
      message: chatMsg.message,
      booking_ref: chatMsg.booking_ref,
      booking_status: chatMsg.booking_status,
      is_read_by_player: chatMsg.is_read_by_player,
      is_read_by_admin: chatMsg.is_read_by_admin,
      created_at: chatMsg.created_at
    });
  } catch (e) {}
}

/**
 * Post an automated Booking / Digital Pass Card into the player's In-App Account Chat
 */
async function postBookingSystemMessage(reservation, eventType, extraSummary = {}) {
  try {
    const userId = await resolveReservationUserId(reservation);
    if (!userId) return null;

    const ref = reservation.reference_number;
    const courtName = extraSummary.courtSummary || (reservation.court ? reservation.court.display_name : `Court ${reservation.court_id}`);
    const dateStr = reservation.reservation_date;
    const timeStr = `${formatTime12(reservation.start_time)} – ${formatTime12(reservation.end_time)}`;
    const totalAmt = extraSummary.totalAmount !== undefined
      ? parseFloat(extraSummary.totalAmount).toFixed(2)
      : parseFloat(reservation.total_amount || 0).toFixed(2);

    let text = '';
    let status = reservation.status;

    if (eventType === 'BOOKING_CREATED') {
      status = 'AWAITING_PAYMENT';
      text = `🏟️ Booking Hold Created (#${ref})\nCourt: ${courtName}\nDate: ${dateStr} (${timeStr})\nTotal Due: ₱${totalAmt}\n\nYour court slot is held for 15 minutes. Tap below to complete your GCash QR payment.`;
    } else if (eventType === 'PAYMENT_SUBMITTED') {
      status = 'AWAITING_CONFIRMATION';
      text = `🧾 GCash Payment Proof Submitted (#${ref})\nGCash Ref: ${reservation.gcash_reference_no || 'Uploaded'}\nAmount: ₱${totalAmt}\n\nOur admin team is now verifying your transfer. You will receive your confirmed Digital Pass right here in chat!`;
    } else if (eventType === 'BOOKING_CONFIRMED') {
      status = 'CONFIRMED';
      text = `🎉 BOOKING CONFIRMED! (#${ref})\nCourt: ${courtName}\nDate: ${dateStr} (${timeStr})\nAmount Paid: ₱${totalAmt}\n\nYour court reservation is officially confirmed! Tap below to open your Digital Court Pass.`;
    } else if (eventType === 'BOOKING_CANCELLED') {
      status = 'CANCELLED';
      text = `⚠️ Booking Cancelled (#${ref})\nCourt: ${courtName} on ${dateStr}\nReason: ${reservation.cancellation_reason || 'Cancelled by Administrator'}`;
    } else {
      text = `📋 Booking Update (#${ref}) — Status: ${status}`;
    }

    const chatMsg = await ChatMessage.create({
      user_id: userId,
      sender_role: 'system',
      sender_name: 'The Playground Bot',
      message: text,
      booking_ref: ref,
      booking_status: status,
      is_read_by_player: false,
      is_read_by_admin: true
    });

    broadcastChatMessage(chatMsg);
    return chatMsg;
  } catch (err) {
    console.warn('[ChatService] Failed to post booking message:', err.message);
    return null;
  }
}

/**
 * Ensure existing bookings for a user have at least one system card in their chat
 */
async function syncExistingBookingsToChat(user) {
  try {
    if (!user || !user.id) return;
    const count = await ChatMessage.count({ where: { user_id: user.id } });
    if (count > 0) return;

    // Welcome message
    await ChatMessage.create({
      user_id: user.id,
      sender_role: 'system',
      sender_name: 'The Playground Pickleball',
      message: `👋 Welcome to The Playground Pickleball, ${user.full_name || user.username}! All your court reservation updates, payment verifications, and digital passes will appear automatically in this chat. You can also message our Admin team anytime right here.`,
      booking_ref: null,
      booking_status: null,
      is_read_by_player: false,
      is_read_by_admin: true
    });

    // Also backfill cards for any existing bookings belonging to this user
    const existingResvs = await Reservation.findAll({
      where: { user_id: user.id },
      include: [{ model: Court, as: 'court' }],
      order: [['created_at', 'ASC']]
    });

    const seenRefs = new Set();
    for (const r of existingResvs) {
      if (seenRefs.has(r.reference_number)) continue;
      seenRefs.add(r.reference_number);

      let evType = 'BOOKING_CREATED';
      if (r.status === 'CONFIRMED') evType = 'BOOKING_CONFIRMED';
      else if (r.status === 'AWAITING_CONFIRMATION') evType = 'PAYMENT_SUBMITTED';
      else if (r.status === 'CANCELLED') evType = 'BOOKING_CANCELLED';

      await postBookingSystemMessage(r, evType);
    }
  } catch (err) {
    console.warn('[ChatService] Sync existing bookings error:', err.message);
  }
}

module.exports = {
  postBookingSystemMessage,
  syncExistingBookingsToChat,
  broadcastChatMessage,
  resolveReservationUserId
};
