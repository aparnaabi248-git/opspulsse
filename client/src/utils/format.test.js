import { describe, it, expect } from 'vitest';
import {
  formatMs,
  formatNumber,
  formatRelative,
  formatDateTime,
  formatDuration,
  truncateUrl,
  initials,
} from '../utils/format';

describe('formatMs', () => {
  it('shows milliseconds below a second', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(412)).toBe('412 ms');
    expect(formatMs(999)).toBe('999 ms');
  });

  it('switches to seconds with two decimals', () => {
    expect(formatMs(1000)).toBe('1.00 s');
    expect(formatMs(1450)).toBe('1.45 s');
  });

  it('drops to one decimal for large values', () => {
    expect(formatMs(12345)).toBe('12.3 s');
  });

  it('never fakes a value it does not have', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(NaN)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('formats with the requested precision', () => {
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(56.141, 2)).toBe('56.14');
  });

  it('renders a dash for missing data instead of zero', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-10-15T12:00:00.000Z').getTime();

  it('describes past times', () => {
    expect(formatRelative('2026-10-15T11:59:40.000Z', now)).toBe('just now');
    expect(formatRelative('2026-10-15T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatRelative('2026-10-15T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-10-13T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('describes future times', () => {
    expect(formatRelative('2026-10-15T12:00:20.000Z', now)).toBe('in a moment');
    expect(formatRelative('2026-10-15T12:45:00.000Z', now)).toBe('in 45m');
    expect(formatRelative('2026-10-15T13:30:00.000Z', now)).toBe('in 2h');
  });

  it('returns a dash when there is no timestamp', () => {
    expect(formatRelative(null, now)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('scales from seconds to days', () => {
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(90_000_000)).toBe('1d 1h 0m');
  });
});

describe('truncateUrl', () => {
  it('leaves short URLs alone', () => {
    expect(truncateUrl('https://example.com')).toBe('https://example.com');
  });

  it('trims the middle, keeping both ends readable', () => {
    const long = 'https://example.com/a/very/long/path/that/goes/on/and/on/forever';
    const out = truncateUrl(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain('...');
    expect(out.startsWith('https://')).toBe(true);
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Smoke Test')).toBe('ST');
    expect(initials('Ada Lovelace King')).toBe('AL');
  });

  it('falls back safely', () => {
    expect(initials('')).toBe('?');
    expect(initials(undefined)).toBe('?');
  });
});

describe('formatDateTime', () => {
  it('returns a dash for missing values', () => {
    expect(formatDateTime(null)).toBe('—');
  });

  it('produces a non-empty string for a real date', () => {
    expect(formatDateTime('2026-10-15T12:00:00.000Z')).toContain('2026');
  });
});