/**
 * OpsPulse uptime calculation rules
 * --------------------------------
 * 1. Every persisted CheckResult is exactly one data point.
 * 2. Uptime % = (up + degraded * DEGRADED_CREDIT) / totalRecordedChecks * 100
 *    DEGRADED_CREDIT defaults to 0.5 — a degraded service is half working,
 *    so it counts as half a successful check.
 * 3. Missing checks are NEVER silently counted as success. If the scheduler
 *    was down, or the monitor was paused, those slots are reported as
 *    `unknown` and used for a separate "coverage" figure.
 * 4. If there are no recorded checks at all we return `uptimePercentage: null`
 *    instead of a misleading 0% or 100%.
 */

const DEGRADED_CREDIT = 0.5;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * @param {Array<{status:string}>} checks  persisted CheckResult documents
 * @param {{degradedCredit?:number, expectedChecks?:number|null}} options
 */
const calculateUptime = (checks = [], options = {}) => {
  const { degradedCredit = DEGRADED_CREDIT, expectedChecks = null } = options;

  const counts = { up: 0, down: 0, degraded: 0 };
  for (const check of checks) {
    if (counts[check.status] !== undefined) counts[check.status] += 1;
  }

  const totalRecordedChecks = counts.up + counts.down + counts.degraded;
  const weightedSuccess = counts.up + counts.degraded * degradedCredit;

  const uptimePercentage =
    totalRecordedChecks === 0 ? null : round2((weightedSuccess / totalRecordedChecks) * 100);

  const unknownChecks =
    expectedChecks == null ? 0 : Math.max(0, expectedChecks - totalRecordedChecks);

  const coveragePercentage =
    expectedChecks && expectedChecks > 0
      ? round2((totalRecordedChecks / expectedChecks) * 100)
      : null;

  return {
    totalRecordedChecks,
    up: counts.up,
    down: counts.down,
    degraded: counts.degraded,
    unknownChecks,
    uptimePercentage,
    coveragePercentage,
    degradedCredit,
  };
};

/**
 * How many checks *should* have happened between two timestamps.
 * Used to expose scheduler downtime instead of hiding it.
 *
 * @param {Date|number} from
 * @param {Date|number} to
 * @param {number} intervalSeconds
 */
const estimateExpectedChecks = (from, to, intervalSeconds) => {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  if (!intervalSeconds || intervalSeconds <= 0) return 0;
  return Math.floor((end - start) / 1000 / intervalSeconds);
};

/**
 * Milliseconds a monitor was DOWN, derived from real check timestamps.
 * Walks the ordered check list; each failed check contributes the time
 * until the next successful check (capped at `now`).
 */
const calculateDowntimeMs = (checks = [], now = Date.now()) => {
  const ordered = [...checks].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
  let downtimeMs = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i].status !== 'down') continue;
    const from = new Date(ordered[i].checkedAt).getTime();
    const next = ordered[i + 1];
    const to = next ? new Date(next.checkedAt).getTime() : now;
    if (to > from) downtimeMs += to - from;
  }

  return downtimeMs;
};

module.exports = {
  DEGRADED_CREDIT,
  calculateUptime,
  calculateDowntimeMs,
  estimateExpectedChecks,
};