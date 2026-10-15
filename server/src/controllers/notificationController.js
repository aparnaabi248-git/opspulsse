const Notification = require('../models/Notification');
const TeamMember = require('../models/TeamMember');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { getUnreadCount } = require('../services/alertService');
const { emitToUser } = require('../socket');

/**
 * Notification controller — the in-app notification centre.
 * A user can only ever read or modify their OWN notifications.
 */

// ── GET /api/notifications ───────────────────────────────────────────
const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { unread, type } = req.query;

  const filter = { user: req.user._id };
  if (unread === 'true') filter.read = false;
  if (type) filter.type = type;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    getUnreadCount(req.user._id),
  ]);

  res.json({
    success: true,
    data: {
      notifications,
      unreadCount,
      pagination: buildPaginationMeta({ page, limit, total }),
    },
  });
});

// ── GET /api/notifications/unread-count ──────────────────────────────
const unreadCount = asyncHandler(async (req, res) => {
  const count = await getUnreadCount(req.user._id);
  res.json({ success: true, data: { unreadCount: count } });
});

// ── POST /api/notifications/:notificationId/read ─────────────────────
const markAsRead = asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.notificationId || '')) {
    throw new ApiError(404, 'Notification not found.');
  }

  // Scoped to req.user — another user's notification is simply not matched
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.notificationId, user: req.user._id },
    { $set: { read: true, readAt: new Date() } },
    { new: true }
  );

  if (!notification) throw new ApiError(404, 'Notification not found.');

  const count = await getUnreadCount(req.user._id);
  emitToUser(req.user._id, 'notification:read', {
    id: String(notification._id),
    unreadCount: count,
  });

  res.json({
    success: true,
    message: 'Notification marked as read.',
    data: { notification, unreadCount: count },
  });
});

// ── POST /api/notifications/read-all ─────────────────────────────────
const markAllAsRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { user: req.user._id, read: false },
    { $set: { read: true, readAt: new Date() } }
  );

  emitToUser(req.user._id, 'notification:read', { unreadCount: 0 });

  res.json({
    success: true,
    message: `${result.modifiedCount} notification(s) marked as read.`,
    data: { updated: result.modifiedCount, unreadCount: 0 },
  });
});

// ── DELETE /api/notifications/:notificationId ────────────────────────
const deleteNotification = asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.notificationId || '')) {
    throw new ApiError(404, 'Notification not found.');
  }

  const result = await Notification.deleteOne({
    _id: req.params.notificationId,
    user: req.user._id,
  });

  if (result.deletedCount === 0) throw new ApiError(404, 'Notification not found.');

  const count = await getUnreadCount(req.user._id);
  res.json({ success: true, message: 'Notification deleted.', data: { unreadCount: count } });
});

// ── GET /api/notifications/preferences ───────────────────────────────
const emailStatus = asyncHandler(async (req, res) => {
  const emailService = require('../services/emailService');
  const memberships = await TeamMember.find({ user: req.user._id }).countDocuments();
  res.json({
    success: true,
    data: {
      emailConfigured: emailService.isConfigured(),
      workspaces: memberships,
    },
  });
});

module.exports = {
  listNotifications,
  unreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  emailStatus,
};