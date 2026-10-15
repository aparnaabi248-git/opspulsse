const mongoose = require('mongoose');
const CheckResult = require('../models/CheckResult');
const Monitor = require('../models/Monitor');
const Incident = require('../models/Incident');
const TeamMember = require('../models/TeamMember');
const { calculateUptime, estimateExpectedChecks } = require('../utils/uptime');

/**
 * Report service
 * ==============
 * Daily and weekly summaries built from real CheckResult rows.
 *
 * Rules that apply everywhere here:
 *   - a day with no checks is returned with count 0 and a null uptime, not 100%
 *   - "expected" counts come from each monitor's own interval, so scheduler
 *     downtime shows up as a gap instead of being quietly ignored
 */

const toObjectIds = (ids) => ids.map((id) => new mongoose.Types.ObjectId(String(id)));

const startOfDay = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

async function resolveScope(userId, teamId) {
  const memberships = await TeamMember.find({ user: userId }).select('team');
  const allIds = memberships.map((m) => String(m.team));

  if (!allIds.length) return null;
  if (teamId) {
    if (!allIds.includes(String(teamId))) return null;
    return [String(teamId)];
  }
  return allIds;
}

/** One entry per UTC day (or week), always continuous, gaps left null. */
function buildContinuousPeriods(start, end, stepMs, measured) {
  const byTime = new Map(measured.map((m) => [new Date(m._id).getTime(), m]));
  const periods = [];

  for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
    const hit = byTime.get(t);
    if (!hit) {
      periods.push({
        periodStart: new Date(t).toISOString(),
        total: 0,
        up: 0,
        down: 0,
        degraded: 0,
        uptimePercentage: null,
        avgResponseTime: null,
        maxResponseTime: null,
        incidents: 0,
        downtimeMs: 0,
      });
      continue;
    }

    periods.push({
      periodStart: new Date(t).toISOString(),
      total: hit.total,
      up: hit.up,
      down: hit.down,
      degraded: hit.degraded,
      uptimePercentage:
        hit.total === 0
          ? null
          : Math.round(((hit.up + hit.degraded * 0.5) / hit.total) * 10000) / 100,
      avgResponseTime: hit.avgResponseTime === null ? null : Math.round(hit.avgResponseTime),
      maxResponseTime: hit.maxResponseTime,
      incidents: hit.incidents || 0,
      downtimeMs: hit.downtimeMs || 0,
    });
  }

  return periods;
}

/**
 * Daily summary for a workspace.
 *
 * @param {string} userId
 * @param {{teamId?:string|null, days?:number, monitorId?:string|null}} options
 */
async function getDailyReport(userId, { teamId = null, days = 30, monitorId = null } = {}) {
  const scope = await resolveScope(userId, teamId);
  if (scope === null) return { error: 'FORBIDDEN_OR_EMPTY' };

  const teamIds = toObjectIds(scope);
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);

  const now = new Date();
  const end = new Date(startOfDay(now).getTime() + 86_400_000); // tomorrow 00:00 UTC
  const start = new Date(end.getTime() - safeDays * 86_400_000);

  const match = {
    team: { $in: teamIds },
    checkedAt: { $gte: start, $lt: end },
  };
  if (monitorId) match.monitor = new mongoose.Types.ObjectId(String(monitorId));

  const [checkAgg, incidentAgg, monitors] = await Promise.all([
    CheckResult.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateTrunc: { date: '$checkedAt', unit: 'day', timezone: 'UTC' } },
          total: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
          maxResponseTime: { $max: '$responseTimeMs' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Incident.aggregate([
      {
        $match: {
          team: { $in: teamIds },
          ...(monitorId ? { monitor: new mongoose.Types.ObjectId(String(monitorId)) } : {}),
        },
      },
      {
        $group: {
          _id: { $dateTrunc: { date: '$startedAt', unit: 'day', timezone: 'UTC' } },
          count: { $sum: 1 },
        },
      },
    ]),
    Monitor.find({
      team: { $in: teamIds },
      isPaused: false,
      ...(monitorId ? { _id: new mongoose.Types.ObjectId(String(monitorId)) } : {}),
    }).select('intervalSeconds createdAt'),
  ]);

  const incidentsByDay = new Map(incidentAgg.map((r) => [new Date(r._id).getTime(), r.count]));
  const periodMs = 86_400_000;

  const periods = buildContinuousPeriods(start, end, periodMs, checkAgg).map((period) => {
    const dayStart = new Date(period.periodStart).getTime();
    const incidents = incidentsByDay.get(dayStart) || 0;

    // Expected checks for this day across the active monitors
    let expected = 0;
    for (const monitor of monitors) {
      const monitorStart = monitor.createdAt.getTime() > dayStart ? monitor.createdAt.getTime() : dayStart;
      expected += estimateExpectedChecks(monitorStart, new Date(dayStart + periodMs), monitor.intervalSeconds);
    }

    return { ...period, incidents, expectedChecks: expected, coveragePercentage: expected ? Math.round((period.total / expected) * 10000) / 100 : null };
  });

  const withData = periods.filter((p) => p.total > 0);

  return {
    granularity: 'day',
    days: safeDays,
    from: start.toISOString(),
    to: end.toISOString(),
    periods,
    totals: {
      checks: withData.reduce((sum, p) => sum + p.total, 0),
      incidents: periods.reduce((sum, p) => sum + p.incidents, 0),
      worstUptime: withData.length ? Math.min(...withData.map((p) => p.uptimePercentage)) : null,
      bestUptime: withData.length ? Math.max(...withData.map((p) => p.uptimePercentage)) : null,
      avgResponseTime: withData.length
        ? Math.round(withData.reduce((sum, p) => sum + p.avgResponseTime, 0) / withData.length)
        : null,
      daysWithNoData: periods.length - withData.length,
    },
  };
}

/**
 * Weekly summary for a workspace (weeks start on Monday, UTC).
 */
async function getWeeklyReport(userId, { teamId = null, weeks = 12, monitorId = null } = {}) {
  const scope = await resolveScope(userId, teamId);
  if (scope === null) return { error: 'FORBIDDEN_OR_EMPTY' };

  const teamIds = toObjectIds(scope);
  const safeWeeks = Math.min(Math.max(parseInt(weeks, 10) || 12, 1), 52);
  const WEEK_MS = 7 * 86_400_000;

  const now = new Date();
  // Monday 00:00 UTC of the current week
  const dayOfWeek = (now.getUTCDay() + 6) % 7; // Monday = 0
  const thisWeekStart = startOfDay(new Date(now.getTime() - dayOfWeek * 86_400_000));
  const end = new Date(thisWeekStart.getTime() + WEEK_MS);
  const start = new Date(end.getTime() - safeWeeks * WEEK_MS);

  const match = {
    team: { $in: teamIds },
    checkedAt: { $gte: start, $lt: end },
  };
  if (monitorId) match.monitor = new mongoose.Types.ObjectId(String(monitorId));

  const [checkAgg, incidentAgg] = await Promise.all([
    CheckResult.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateTrunc: { date: '$checkedAt', unit: 'week', startOfWeek: 'monday', timezone: 'UTC' } },
          total: { $sum: 1 },
          up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
          degraded: { $sum: { $cond: [{ $eq: ['$status', 'degraded'] }, 1, 0] } },
          avgResponseTime: { $avg: '$responseTimeMs' },
          maxResponseTime: { $max: '$responseTimeMs' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Incident.aggregate([
      {
        $match: {
          team: { $in: teamIds },
          ...(monitorId ? { monitor: new mongoose.Types.ObjectId(String(monitorId)) } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: { date: '$startedAt', unit: 'week', startOfWeek: 'monday', timezone: 'UTC' },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const incidentsByWeek = new Map(incidentAgg.map((r) => [new Date(r._id).getTime(), r.count]));

  const periods = buildContinuousPeriods(start, end, WEEK_MS, checkAgg).map((period) => ({
    ...period,
    incidents: incidentsByWeek.get(new Date(period.periodStart).getTime()) || 0,
  }));

  const withData = periods.filter((p) => p.total > 0);

  return {
    granularity: 'week',
    weeks: safeWeeks,
    from: start.toISOString(),
    to: end.toISOString(),
    periods,
    totals: {
      checks: withData.reduce((sum, p) => sum + p.total, 0),
      incidents: periods.reduce((sum, p) => sum + p.incidents, 0),
      worstUptime: withData.length ? Math.min(...withData.map((p) => p.uptimePercentage)) : null,
      bestUptime: withData.length ? Math.max(...withData.map((p) => p.uptimePercentage)) : null,
      avgResponseTime: withData.length
        ? Math.round(withData.reduce((sum, p) => sum + p.avgResponseTime, 0) / withData.length)
        : null,
      weeksWithNoData: periods.length - withData.length,
    },
  };
}

/**
 * Uptime for one monitor over the whole history it has.
 */
async function getLifetimeReport(userId, monitorId) {
  const monitor = await Monitor.findById(monitorId);
  if (!monitor) return { error: 'NOT_FOUND' };

  const membership = await TeamMember.findOne({ team: monitor.team, user: userId });
  if (!membership) return { error: 'NOT_FOUND' };

  const checks = await CheckResult.find({ monitor: monitor._id })
    .sort({ checkedAt: 1 })
    .select('status checkedAt responseTimeMs')
    .lean();

  const now = new Date();
  const uptime = calculateUptime(checks, {
    expectedChecks: estimateExpectedChecks(monitor.createdAt, now, monitor.intervalSeconds),
  });

  const first = checks[0];
  const last = checks[checks.length - 1];

  return {
    monitorId: String(monitor._id),
    name: monitor.name,
    since: first?.checkedAt ?? monitor.createdAt,
    until: last?.checkedAt ?? null,
    totalChecks: uptime.totalRecordedChecks,
    uptimePercentage: uptime.uptimePercentage,
    unknownChecks: uptime.unknownChecks,
    coveragePercentage: uptime.coveragePercentage,
    counts: { up: uptime.up, down: uptime.down, degraded: uptime.degraded },
  };
}

module.exports = { getDailyReport, getWeeklyReport, getLifetimeReport };