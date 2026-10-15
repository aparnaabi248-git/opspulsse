const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../config/logger');
const User = require('../models/User');
const TeamMember = require('../models/TeamMember');

/**
 * Socket.IO
 * =========
 * Pushes live updates to signed-in users only.
 *
 * Authorisation model
 * -------------------
 * 1. The handshake must carry a valid JWT (auth token from the socket, or the
 *    httpOnly cookie). An anonymous socket is rejected outright — there is no
 *    "public" mode.
 * 2. Every socket is put into exactly two kinds of room:
 *      user:<userId>   -> personal notifications
 *      team:<teamId>   -> monitor and incident events, for teams they belong to
 * 3. Rooms are joined from the database, never from client input. A client
 *    cannot ask to join an arbitrary room, so one workspace can never receive
 *    another workspace's monitor names, URLs or status changes.
 *
 * Known limitation: a user added to a new team must reconnect (or refresh) to
 * join that team's room. Socket.IO handles this automatically on reconnect.
 */

let io = null;

/**
 * Verify the JWT during the Socket.IO handshake.
 */
const handshakeAuth = async (socket, next) => {
  try {
    let token = socket.handshake.auth?.token;

    if (!token && socket.handshake.headers?.cookie) {
      const cookies = Object.fromEntries(
        socket.handshake.headers.cookie.split(';').map((c) => {
          const [k, ...v] = c.trim().split('=');
          return [k, decodeURIComponent(v.join('='))];
        })
      );
      token = cookies.token;
    }

    if (!token) {
      return next(new Error('Authentication required'));
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(decoded.id).select('_id name email');

    if (!user) {
      return next(new Error('This account no longer exists'));
    }

    socket.user = user;
    return next();
  } catch (error) {
    const reason =
      error.name === 'TokenExpiredError'
        ? 'Session expired'
        : error.name === 'JsonWebTokenError'
          ? 'Invalid authentication token'
          : 'Authentication required';
    return next(new Error(reason));
  }
};

/**
 * Attach Socket.IO to the HTTP server.
 * @param {import('http').Server} httpServer
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: config.cors.origins,
      credentials: true,
    },
    path: '/socket.io',
    // Do not let a client buffer events while it is reconnecting forever
    pingTimeout: 20000,
  });

  io.use(handshakeAuth);

  io.on('connection', async (socket) => {
    const { _id, name, email } = socket.user;

    // Personal room
    socket.join(`user:${_id}`);

    // One room per team the user actually belongs to
    try {
      const memberships = await TeamMember.find({ user: _id }).select('team');
      const teamIds = memberships.map((m) => String(m.team));
      for (const teamId of teamIds) socket.join(`team:${teamId}`);

      logger.info('Socket connected', {
        userId: String(_id),
        socketId: socket.id,
        teams: teamIds.length,
      });

      socket.emit('connection:ready', {
        user: { id: String(_id), name, email },
        teamIds,
        at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Socket room join failed', { message: error.message });
      socket.disconnect(true);
      return;
    }

    socket.on('disconnect', (reason) => {
      logger.debug('Socket disconnected', { socketId: socket.id, reason });
    });
  });

  logger.info('Socket.IO ready', { path: '/socket.io' });
  return io;
};

const getIo = () => io;

/**
 * Emit to every member of a team. Safe to call when Socket.IO is not running
 * (for example inside unit tests).
 */
const emitToTeam = (teamId, event, payload) => {
  if (!io || !teamId) return;
  io.to(`team:${teamId}`).emit(event, payload);
};

/** Emit to one specific user. */
const emitToUser = (userId, event, payload) => {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
};

const closeSocket = async () => {
  if (!io) return;
  await io.close();
  io = null;
};

module.exports = { initSocket, getIo, emitToTeam, emitToUser, closeSocket, handshakeAuth };