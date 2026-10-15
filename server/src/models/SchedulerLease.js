const mongoose = require('mongoose');

/**
 * SchedulerLease
 * ==============
 * A tiny distributed lock stored in MongoDB.
 *
 * WHY THIS EXISTS
 * ---------------
 * If you ever run two backend containers behind a load balancer (e.g.
 * `docker compose up --scale backend=2`), BOTH processes would run the
 * scheduler. Each monitor would then be checked twice as often, incidents
 * would be duplicated and uptime numbers would be wrong.
 *
 * OpsPulse solves this with a lease: every backend instance tries to grab the
 * same document. Only the holder schedules checks, and it has to renew the
 * lease before it expires. If an instance dies, the lease expires and another
 * instance takes over automatically.
 *
 * See README "Scaling the scheduler" for the longer-term options
 * (BullMQ / Redis, or sharded workers).
 */

const schedulerLeaseSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // fixed id, e.g. "monitor-scheduler"
    owner: { type: String, required: true }, // instance id of the holder
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

schedulerLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // self-cleanup

module.exports = mongoose.model('SchedulerLease', schedulerLeaseSchema);