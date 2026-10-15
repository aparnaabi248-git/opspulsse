const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema(
  {
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: [true, 'Team reference is required'],
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    role: {
      type: String,
      enum: {
        values: ['owner', 'admin', 'viewer'],
        message: 'Role must be owner, admin, or viewer',
      },
      default: 'viewer',
    },
  },
  {
    timestamps: true, // createdAt acts as "joinedAt"
  }
);

// ── Indexes ──────────────────────────────────────────
// A user can only appear once per team
teamMemberSchema.index({ team: 1, user: 1 }, { unique: true });
// Fast lookup: "which teams does this user belong to?"
teamMemberSchema.index({ user: 1 });

module.exports = mongoose.model('TeamMember', teamMemberSchema);
