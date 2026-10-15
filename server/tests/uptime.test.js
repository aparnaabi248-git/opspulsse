const {
  calculateUptime,
  calculateDowntimeMs,
  estimateExpectedChecks,
} = require('../src/utils/uptime');

/**
 * Uptime and downtime maths.
 *
 * These are pure functions, so the expected values below are computed by hand
 * rather than taken from the running system.
 */

const check = (status, checkedAt) => ({ status, checkedAt });

describe('calculateUptime', () => {
  it('reports 100% for all-UP checks', () => {
    const result = calculateUptime([check('up'), check('up'), check('up')]);
    expect(result).toMatchObject({
      totalRecordedChecks: 3,
      up: 3,
      down: 0,
      degraded: 0,
      uptimePercentage: 100,
    });
  });

  it('reports 0% when every check failed', () => {
    const result = calculateUptime([check('down'), check('down')]);
    expect(result.uptimePercentage).toBe(0);
  });

  it('counts a degraded check as half a success (50% credit)', () => {
    const result = calculateUptime([check('up'), check('degraded')]);
    expect(result.uptimePercentage).toBe(75);
    expect(result.degraded).toBe(1);
  });

  it('honours a custom degraded credit of 0', () => {
    const result = calculateUptime([check('up'), check('degraded')], { degradedCredit: 0 });
    expect(result.uptimePercentage).toBe(50);
  });

  it('does not treat missing data as success', () => {
    // 10 checks were expected but only 4 were recorded
    const result = calculateUptime([check('up'), check('up'), check('up'), check('down')], {
      expectedChecks: 10,
    });

    expect(result.totalRecordedChecks).toBe(4);
    expect(result.uptimePercentage).toBe(75);
    expect(result.unknownChecks).toBe(6);
    expect(result.coveragePercentage).toBe(40);
  });

  it('returns null instead of a misleading number when there is no data', () => {
    const result = calculateUptime([]);
    expect(result.uptimePercentage).toBeNull();
    expect(result.totalRecordedChecks).toBe(0);
  });
});

describe('estimateExpectedChecks', () => {
  it('counts how many checks should have happened in a window', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-01T01:00:00.000Z'); // 1 hour
    expect(estimateExpectedChecks(from, to, 60)).toBe(60);
    expect(estimateExpectedChecks(from, to, 300)).toBe(12);
  });

  it('returns 0 for an invalid window or interval', () => {
    const from = new Date('2026-01-01T01:00:00.000Z');
    const to = new Date('2026-01-01T00:00:00.000Z');
    expect(estimateExpectedChecks(from, to, 60)).toBe(0);
    expect(estimateExpectedChecks(from, from, 60)).toBe(0);
    expect(estimateExpectedChecks(new Date(), new Date(Date.now() + 60000), 0)).toBe(0);
  });
});

describe('calculateDowntimeMs', () => {
  it('adds the gap from each failed check to the next check', () => {
    const checks = [
      check('up', '2026-01-01T00:00:00.000Z'),
      check('down', '2026-01-01T00:01:00.000Z'),
      check('down', '2026-01-01T00:02:00.000Z'),
      check('up', '2026-01-01T00:03:00.000Z'),
    ];
    // 1 minute (00:01 -> 00:02) + 1 minute (00:02 -> 00:03)
    expect(calculateDowntimeMs(checks)).toBe(120_000);
  });

  it('keeps counting the last outage up to "now"', () => {
    const checks = [check('down', '2026-01-01T00:00:00.000Z')];
    const now = new Date('2026-01-01T00:10:00.000Z').getTime();
    expect(calculateDowntimeMs(checks, now)).toBe(600_000);
  });

  it('returns 0 when everything was UP', () => {
    const checks = [check('up', '2026-01-01T00:00:00.000Z'), check('up', '2026-01-01T00:01:00.000Z')];
    expect(calculateDowntimeMs(checks)).toBe(0);
  });

  it('is not affected by unordered input', () => {
    const ordered = [
      check('down', '2026-01-01T00:00:00.000Z'),
      check('up', '2026-01-01T00:01:00.000Z'),
    ];
    const shuffled = [ordered[1], ordered[0]];
    expect(calculateDowntimeMs(shuffled)).toBe(calculateDowntimeMs(ordered));
  });
});