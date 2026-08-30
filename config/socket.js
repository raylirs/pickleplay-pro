const { Server } = require('socket.io');

let io = null;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    // Join a room for a specific court or general availability
    socket.on('join_court_room', (courtId) => {
      socket.join(court_);
    });

    socket.on('leave_court_room', (courtId) => {
      socket.leave(court_);
    });

    socket.on('disconnect', () => {
      // client disconnected
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}

module.exports = { initSocket, getIO };
