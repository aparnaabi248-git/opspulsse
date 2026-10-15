const mongoose = require('mongoose');
const CheckResult = require('../models/CheckResult');
const Monitor = require('../models/Monitor');
const TeamMember = require('../models/TeamMember');
const Incident = require('../models/Incident');
const { calculateUptime, calculateDowntimeMs, estimateExpectedChecks } = require('../utils/uptime');

/**
 * Analytics service
 * =================
 * Every number produced here is calculated from real, persisted CheckResult
 * documents. Nothing is estimated and nothing is filled in with sample data.
 *
 * Honest gaps
 * -----------
 * When a bucket has no check results at all (scheduler downtime, paused
 * monitor, brand new monitor) the bucket is returned with `count: 0` and a null
 * uptime / response time. The chart draws a gap instead of a straight line,
 * because inventing a value would be a lie.
 */

const RANGES = {
  '1h': { hours: 1, unit: 'minute', bucketMinutes: 5 },
  '24h': { hours: 24, unit: 'hour', bucketMinutes: 60 },
  '7d': { hours: 24 * 7, unit: 'hour', bucketMinutes: 360 },
  '30d': { hours: 24 * 30, unit: 'day', bucketMinutes: 1440 },
};

const DEFAULT_RANGE = '24h';

/** Falls back to the default for anything unknown, and reports what it used. */
const resolveRange = (range) => {
  const key = RANGES[range] ? range : DEFAULT_RANGE;
  return { ...RANGES[key], key };
};

const toObjectIds = (ids) => ids.map((id) => new mongoose.Types.ObjectId(String(id)));

/** Team ids the user is a member of (or one specific team they belong to). */
async function resolveTeamScope(userId, teamId) {
  const memberships = await TeamMember.find({ user: userId }).select('team');
  const allIds = memberships.map((m) => String(m.team));

  if (teamId) {
    return allIds.includes(String(teamId)) ? [String(teamId)] : null;
  }
  return allIds;
}

/** Build a continuous list of buckets, marking the empty ones as unknown. */
function buildBuckets(start, end, bucketMs, measured) {
  const buckets = [];
  const byTime = new Map(measured.map((m) => [m._id.getTime(), m]));

  for (let t = start.getTime(); t < end.getTime(); t += bucketMs) {
    const hit = byTime.get(t);
    buckets.push(
      hit
        ? { at: new Date(t).toISOString(), ...hit.stats }
        : {
            at: new Date(t).toISOString(),
            count: 0,
            up: 0,
            down: 0,
            degraded: 0,
            avgResponseTime: null,
            minResponseTime: null,
            maxResponseTime: null,
            uptimePercentage: null, // <- missing data, not "100%"
          }
    );
  }
  return buckets;
}

/**
 * GET /api/dashboard/summary
 * The headline numbers on the dashboard.
 */
async function getSummary(userId, { teamId = null, range = '24h' } = {}) {
  const scope = await resolveTeamScope(userId, teamId);
  if (scope === null) return { error: 'FORBIDDEN' };

  const teamIds = toObjectIds(scope);
  const { key: rangeKey, hours, unit, bucketMinutes } = resolveRange(range);
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const bucketMs = bucketMinutes * 60 * 1000;

  const now = new Date();
  const floorTo = (d) => {
    const x = new Date(d);
    x.setUTCMinutes(0, 0, 0);
    if (unit === 'day') x.setUTCHours(0, 0, 0, 0);
    return x;
  };
  const bucketStart = floorTo(since);

  const [monitorCounts, recentChecks, bucketsAgg, activeIncidents] = await Promise.all([
    Monitor.aggregate([
      { $match: { team: { $in: teamIds } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]),
    CheckResult.aggregate([
      { $match: { team: { $in: teamIds }, checkedAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
          slowest: { $max: '$responseTimeMs' },
          fastest: { $min: '$responseTimeMs' },
        },
      },
    ]),
    CheckResult.aggregate([
      { $match: { team: { $in: teamIds }, checkedAt: { $gte: bucketStart } } },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$checkedAt',
              unit,
              binSize: bucketMinutes,
              timezone: 'UTC',
            },
          },
          count: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
          minResponseTime: { $min: '$responseTimeMs' },
          maxResponseTime: { $max: '$responseTimeMs' },
        },
      },
      {
        $project: {
          _id: 1,
          count: 1,
          up: 1,
          down: 1,
          degraded: 1,
          avgResponseTime: 1,
          minResponseTime: 1,
          maxResponseTime: 1,
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Incident.countDocuments({ team: { $in: teamIds }, active: true }),
  ]);

  const statusCounts = { pending: 0, up: 0, down: 0, degraded: 0, paused: 0 };
  let totalMonitors = 0;
  for (const row of monitorCounts) {
    statusCounts[row._id] = row.count;
    totalMonitors += row.count;
  }

  const totals = recentChecks[0] || {
    total: 0,
    up: 0,
    down: 0,
    degraded: 0,
    avgResponseTime: null,
    slowest: null,
    fastest: null,
  };

  const expectedChecks = await estimateExpectedChecksFromMonitors(teamIds, since, now);

  const uptime = calculateUptime(
    [
      ...Array(totals.up).fill({ status: 'up' }),
      ...Array(totals.down).fill({ status: 'down' }),
      ...Array(totals.degraded).fill({ status: 'degraded' }),
    ],
    { expectedChecks }
  );

  const buckets = buildBuckets(bucketStart, now, bucketMs, bucketsAgg).map((b) => ({
    ...b,
    uptimePercentage:
      b.count === 0
        ? null
        : Math.round(((b.up + b.degraded * 0.5) / b.count) * 10000) / 100,
    avgResponseTime: b.avgResponseTime === null ? null : Math.round(b.avgResponseTime),
  }));

  return {
    range: rangeKey,
    generatedAt: now.toISOString(),
    monitors: {
      total: totalMonitors,
      up: statusCounts.up,
      down: statusCounts.down,
      degraded: statusCounts.degraded,
      paused: statusCounts.paused,
      pending: statusCounts.pending,
    },
    uptime: {
      percentage: uptime.uptimePercentage,
      totalRecordedChecks: uptime.totalRecordedChecks,
      unknownChecks: uptime.unknownChecks,
      coveragePercentage: uptime.coveragePercentage,
    },
    responseTime: {
      averageMs: totals.avgResponseTime === null ? null : Math.round(totals.avgResponseTime),
      fastestMs: totals.fastest,
      slowestMs: totals.slowest,
    },
    checks: { total: totals.total, up: totals.up, down: totals.down, degraded: totals.degraded },
    activeIncidents,
    series: buckets,
  };
}

/**
 * How many checks *should* have happened since `since`, based on the current
 * interval of each non-paused monitor. Used to expose scheduler downtime.
 */
async function estimateExpectedChecksFromMonitors(teamIds, since, now) {
  const monitors = await Monitor.find({
    team: { $in: teamIds },
    isPaused: false,
  }).select('intervalSeconds createdAt');

  let total = 0;
  for (const m of monitors) {
    // Never expect checks before the monitor was created
    const from = m.createdAt > since ? m.createdAt : since;
    total += estimateExpectedChecks(from, now, m.intervalSeconds);
  }
  return total;
}

/**
 * GET /api/analytics/monitors/:monitorId
 * Deep analytics for one monitor.
 */
async function getMonitorAnalytics(monitorId, { range = '24h' } = {}) {
  const monitor = await Monitor.findById(monitorId);
  if (!monitor) return { error: 'NOT_FOUND' };

  const { hours, unit, bucketMinutes } = resolveRange(range);
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const now = new Date();
  const bucketMs = bucketMinutes * 60 * 1000;

  const floorTo = (d) => {
    const x = new Date(d);
    x.setUTCMinutes(0, 0, 0);
    if (unit === 'day') x.setUTCHours(0, 0, 0, 0);
    return x;
  };
  const bucketStart = floorTo(since);

  const [bucketsAgg, checks, dailyAgg] = await Promise.all([
    CheckResult.aggregate([
      { $match: { monitor: monitor._id, checkedAt: { $gte: bucketStart } } },
      {
        $group: {
          _id: {
            $dateTrunc: { date: '$checkedAt', unit, binSize: bucketMinutes, timezone: 'UTC' },
          },
          count: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
          minResponseTime: { $min: '$responseTimeMs' },
          maxResponseTime: { $max: '$responseTimeMs' },
          totalDowntimeMs: { $sum: '$responseTimeMs' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CheckResult.find({ monitor: monitor._id, checkedAt: { $gte: since } })
      .sort({ checkedAt: 1 })
      .select('status checkedAt responseTimeMs statusCode outcome errorMessage')
      .lean(),
    CheckResult.aggregate([
      { $match: { monitor: monitor._id, checkedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateTrunc: { date: '$checkedAt', unit: 'day', timezone: 'UTC' } },
          count: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
          downtimeMs: {
            $sum: { $cond: [{ $eq: ['$status', 'down'] }, '$responseTimeMs', 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const uptime = calculateUptime(checks, {
    expectedChecks: estimateExpectedChecks(
      monitor.createdAt > since ? monitor.createdAt : since,
      now,
      monitor.intervalSeconds
    ),
  });

  // Failure runs: how many separate outage episodes happened
  let failureRuns = 0;
  let previousDown = false;
  for (const c of checks) {
    const isDown = c.status === 'down';
    if (isDown && !previousDown) failureRuns += 1;
    previousDown = isDown;
  }

  const series = buildBuckets(bucketStart, now, bucketMs, bucketsAgg).map((b) => ({
    ...b,
    uptimePercentage:
      b.count === 0 ? null : Math.round(((b.up + b.degraded * 0.5) / b.count) * 10000) / 100,
    avgResponseTime: b.avgResponseTime === null ? null : Math.round(b.avgResponseTime),
  }));

  const responseTimes = checks.map((c) => c.responseTimeMs).sort((a, b) => a - b);
  const percentile = (p) =>
    responseTimes.length === 0
      ? null
      : responseTimes[Math.min(responseTimes.length - 1, Math.floor(responseTimes.length * p))];

  return {
    monitorId: String(monitor._id),
    name: monitor.name,
    range: RANGES[range] ? range : DEFAULT_RANGE,
    generatedAt: now.toISOString(),
    uptime: {
      percentage: uptime.uptimePercentage,
      totalRecordedChecks: uptime.totalRecordedChecks,
      unknownChecks: uptime.unknownChecks,
      coveragePercentage: uptime.coveragePercentage,
    },
    responseTime: {
      averageMs:
        responseTimes.length === 0
          ? null
          : Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      minMs: responseTimes[0] ?? null,
      maxMs: responseTimes[responseTimes.length - 1] ?? null,
    },
    reliability: {
      failureRuns,
      failedChecks: checks.filter((c) => c.status === 'down').length,
      degradedChecks: checks.filter((c) => c.status === 'degraded').length,
      downtimeMs: calculateDowntimeMs(checks, now.getTime()),
    },
    series,
    daily: dailyAgg.map((d) => ({
      date: d._id,
      count: d.count,
      up: d.up,
      down: d.down,
      degraded: d.degraded,
      uptimePercentage: Math.round(((d.up + d.degraded * 0.5) / d.count) * 10000) / 100,
      avgResponseTime: Math.round(d.avgResponseTime),
    })),
  };
}

/**
 * GET /api/analytics/monitors
 * A sortable table of every monitor with its headline analytics.
 */
async function getMonitorTable(userId, { teamId = null, range = '24h' } = {}) {
  const scope = await resolveTeamScope(userId, teamId);
  if (scope === null) return { error: 'FORBIDDEN' };
  const teamIds = toObjectIds(scope);

  const { hours } = resolveRange(range);
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const [monitors, stats] = await Promise.all([
    Monitor.find({ team: { $in: teamIds } }).sort({ createdAt: -1 }).lean(),
    CheckResult.aggregate([
      { $match: { team: { $in: teamIds }, checkedAt: { $gte: since } } },
      {
        $group: {
          _id: '$monitor',
          count: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
        },
      },
    ]),
  ]);

  const byMonitor = new Map(stats.map((s) => [String(s._id), s]));

  return {
    monitors: monitors.map((m) => {
      const s = byMonitor.get(String(m._id));
      return {
        id: String(m._id),
        name: m.name,
        url: m.url,
        status: m.status,
        team: m.team,
        intervalSeconds: m.intervalSeconds,
        lastCheckAt: m.lastCheckAt,
        lastStatusCode: m.lastStatusCode,
        lastResponseTimeMs: m.lastResponseTimeMs,
        lastError: m.lastError,
        isPaused: m.isPaused,
        uptimePercentage: s
          ? Math.round(((s.up + s.degraded * 0.5) / s.count) * 10000) / 100
          : null,
        avgResponseTimeMs: s ? Math.round(s.avgResponseTime) : null,
        checksInRange: s ? s.count : 0,
        downInRange: s ? s.down : 0,
      };
    }),
  };
}

module.exports = { getSummary, getMonitorAnalytics, getMonitorTable, RANGES };