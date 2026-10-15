const os = require('os');
const crypto = require('crypto');
const SchedulerLease = require('../models/SchedulerLease');
const logger = require('../config/logger');

/**
 * MongoDB backed lease used to guarantee that only ONE backend instance runs
 * the monitoring scheduler at a time.
 */

const LEASE_ID = 'monitor-scheduler';

class Lease {
  /**
   * @param {{ttlMs?: number, leaseId?: string}} options
   */
  constructor({ ttlMs = 30_000, leaseId = LEASE_ID } = {}) {
    this.ttlMs = ttlMs;
    this.leaseId = leaseId;
    // A unique id for this process: hostname + pid + random suffix
    this.instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
    this.held = false;
    this.renewTimer = null;
    this.onLost = null;
  }

  /**
   * Try to become the lease holder.
   * @returns {Promise<boolean>} true when this instance now owns the lease
   */
  async acquire() {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    try {
      const result = await SchedulerLease.findOneAndUpdate(
        {
          _id: this.leaseId,
          // Either nobody holds it, it expired, or we already hold it
          $or: [{ expiresAt: { $lte: now } }, { owner: this.instanceId }],
        },
        { $set: { owner: this.instanceId, acquiredAt: now, expiresAt } },
        { new: true, upsert: true }
      );

      this.held = result?.owner === this.instanceId;

      if (!this.held) {
        logger.info('Scheduler lease is held by another instance — this one stays passive', {
          holder: result?.owner,
        });
      }

      return this.held;
    } catch (error) {
      // Another instance inserted the same _id first: normal contention
      if (error.code === 11000) {
        this.held = false;
        return false;
      }
      throw error;
    }
  }

  /**
   * Renew the lease so other instances do not take over while we are alive.
   */
  async renew() {
    if (!this.held) return false;

    const now = new Date();
    const result = await SchedulerLease.updateOne(
      { _id: this.leaseId, owner: this.instanceId },
      { $set: { expiresAt: new Date(now.getTime() + this.ttlMs) } }
    );

    if (result.matchedCount === 0) {
      // Somebody else grabbed it (impossible while we hold it, but be safe)
      this.held = false;
      if (this.onLost) this.onLost();
      logger.warn('Lost the scheduler lease');
      return false;
    }
    return true;
  }

  /** Renew automatically at half the TTL. */
  startRenewal() {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => {
      this.renew().catch((error) => logger.error('Lease renewal failed', { message: error.message }));
    }, Math.floor(this.ttlMs / 2));
    this.renewTimer.unref();
  }

  /** Stop renewing without giving the lease up (used when demoted). */
  stopRenewal() {
    if (!this.renewTimer) return;
    clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  /** Give the lease back so another instance can take over immediately. */
  async release() {
    this.stopRenewal();
    if (!this.held) return;
    await SchedulerLease.deleteOne({ _id: this.leaseId, owner: this.instanceId });
    this.held = false;
  }
}

module.exports = { Lease, LEASE_ID };