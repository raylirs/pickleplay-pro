const { ChatMessage, User } = require('../models');
const { syncExistingBookingsToChat, broadcastChatMessage } = require('../services/chatService');
const reservationController = require('./reservationController');

const chatController = {
  /**
   * GET /api/account/chat
   * Returns all in-app chat messages (including automated booking cards) for the logged-in player
   */
  async getAccountChatJson(req, res, next) {
    try {
      const currentUser = req.session ? req.session.user : null;
      if (!currentUser || !currentUser.id) {
        return res.json({ loggedIn: false, messages: [], unreadCount: 0 });
      }

      // Sync any existing bookings into the player's chat timeline so their bookings always show up
      await syncExistingBookingsToChat(currentUser);

      if (req.query.markRead === '1') {
        await ChatMessage.update(
          { is_read_by_player: true },
          { where: { user_id: currentUser.id, is_read_by_player: false } }
        );
      }

      const messages = await ChatMessage.findAll({
        where: { user_id: currentUser.id },
        order: [['created_at', 'ASC'], ['id', 'ASC']]
      });

      const unreadCount = await ChatMessage.count({
        where: { user_id: currentUser.id, is_read_by_player: false }
      });

      res.json({
        loggedIn: true,
        unreadCount,
        messages
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/account/chat
   * Player sends a message to Admin inside their account chat
   */
  async sendPlayerChatMessage(req, res, next) {
    try {
      const currentUser = req.session ? req.session.user : null;
      if (!currentUser || !currentUser.id) {
        return res.status(401).json({ error: 'Please sign in to send a message.' });
      }

      const text = (req.body.message || '').trim();
      const bookingRef = req.body.booking_ref ? req.body.booking_ref.trim() : null;
      if (!text) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
      }

      const chatMsg = await ChatMessage.create({
        user_id: currentUser.id,
        sender_role: 'player',
        sender_name: currentUser.full_name || currentUser.username || 'Player',
        message: text,
        booking_ref: bookingRef || null,
        booking_status: null,
        is_read_by_player: true,
        is_read_by_admin: false
      });

      broadcastChatMessage(chatMsg);

      res.json({
        success: true,
        message: chatMsg
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/account/chat/read
   * Marks all messages in the logged-in player's chat as read
   */
  async markPlayerChatRead(req, res, next) {
    try {
      const currentUser = req.session ? req.session.user : null;
      if (!currentUser || !currentUser.id) {
        return res.json({ success: false });
      }

      await ChatMessage.update(
        { is_read_by_player: true },
        { where: { user_id: currentUser.id, is_read_by_player: false } }
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /admin/chat
   * Admin Live Chat & Player Booking Inbox
   */
  async showAdminChatInbox(req, res, next) {
    try {
      const players = await User.findAll({
        where: { role: 'player' },
        order: [['created_at', 'DESC']]
      });

      // Ensure each player's bookings are synced to chat
      const threads = [];
      for (const p of players) {
        await syncExistingBookingsToChat(p);
        const lastMsg = await ChatMessage.findOne({
          where: { user_id: p.id },
          order: [['created_at', 'DESC'], ['id', 'DESC']]
        });
        const unreadAdminCount = await ChatMessage.count({
          where: { user_id: p.id, is_read_by_admin: false }
        });

        threads.push({
          user: {
            id: p.id,
            full_name: p.full_name || p.username,
            email: p.email,
            phone: p.phone,
            fb_psid: p.fb_psid,
            binding_code: p.binding_code
          },
          lastMessage: lastMsg,
          unreadCount: unreadAdminCount
        });
      }

      // Sort threads by unread first, then most recent message timestamp
      threads.sort((a, b) => {
        if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount;
        const timeA = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0;
        const timeB = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0;
        return timeB - timeA;
      });

      res.render('admin/chat', {
        title: 'Player Account Chat & Booking Inbox - The Playground Pickleball',
        layout: 'layouts/admin',
        user: req.session.user,
        threads,
        activeUserId: req.query.user ? parseInt(req.query.user, 10) : (threads[0] ? threads[0].user.id : null)
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /admin/api/chat/:userId
   * Fetches messages and grouped bookings for a specific player account
   */
  async getAdminUserChatJson(req, res, next) {
    try {
      const userId = parseInt(req.params.userId, 10);
      const player = await User.findByPk(userId);
      if (!player) {
        return res.status(404).json({ error: 'Player account not found.' });
      }

      await syncExistingBookingsToChat(player);

      await ChatMessage.update(
        { is_read_by_admin: true },
        { where: { user_id: userId, is_read_by_admin: false } }
      );

      const messages = await ChatMessage.findAll({
        where: { user_id: userId },
        order: [['created_at', 'ASC'], ['id', 'ASC']]
      });

      const bookings = await reservationController.getPlayerReservationsGrouped(player);

      res.json({
        success: true,
        player: {
          id: player.id,
          full_name: player.full_name || player.username,
          email: player.email,
          phone: player.phone,
          fb_psid: player.fb_psid,
          binding_code: player.binding_code
        },
        messages,
        bookings
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /admin/api/chat/:userId
   * Admin sends a reply to a specific player's in-app account chat
   */
  async sendAdminChatMessage(req, res, next) {
    try {
      const userId = parseInt(req.params.userId, 10);
      const player = await User.findByPk(userId);
      if (!player) {
        return res.status(404).json({ error: 'Player account not found.' });
      }

      const text = (req.body.message || '').trim();
      const bookingRef = req.body.booking_ref ? req.body.booking_ref.trim() : null;
      if (!text) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
      }

      const adminName = (req.session && req.session.user && req.session.user.full_name)
        ? req.session.user.full_name
        : 'The Playground Admin';

      const chatMsg = await ChatMessage.create({
        user_id: userId,
        sender_role: 'admin',
        sender_name: adminName,
        message: text,
        booking_ref: bookingRef || null,
        booking_status: null,
        is_read_by_player: false,
        is_read_by_admin: true
      });

      broadcastChatMessage(chatMsg);

      res.json({
        success: true,
        message: chatMsg
      });
    } catch (err) {
      next(err);
    }
  }
};

module.exports = chatController;
