const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * User
 * ====
 * An OpsPulse account. Users belong to one or more teams through TeamMember,
 * and every monitor / incident / notification access is authorised through
 * those memberships.
 */

const NOTIFICATION_TYPES = [
  'monitor_down',
  'monitor_recovered',
  'monitor_degraded',
  'incident_created',
  'incident_acknowledged',
  'incident_resolved',
  'info',
];

const preferencesSchema = new mongoose.Schema(
  {
    // In-app notifications are on by default; email is opt-in because most
    // people do not want an email for every blip.
    inAppEnabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: false },
    emailTypes: {
      type: [String],
      enum: { values: NOTIFICATION_TYPES },
      default: () => ['monitor_down', 'monitor_recovered', 'incident_created', 'incident_resolved'],
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // Never return password in queries by default
    },

    preferences: { type: preferencesSchema, default: () => ({}) },

    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// ── Indexes ──────────────────────────────────────────
// The unique index on email is already declared on the field above.
// Declaring it a second time only produces a Mongoose warning.

// ── Pre-save: hash password ──────────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Instance methods ─────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/** Should this user receive an email for this notification type? */
userSchema.methods.wantsEmailFor = function wantsEmailFor(type) {
  if (!this.preferences?.emailEnabled) return false;
  return this.preferences.emailTypes.includes(type);
};

// Strip password from JSON serialization
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;