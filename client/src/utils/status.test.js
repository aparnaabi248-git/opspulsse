import { describe, it, expect } from 'vitest';
import { statusMeta, STATUS_META, CHART_COLORS, RANGE_OPTIONS } from './status';

describe('statusMeta', () => {
  it('knows every real monitor status', () => {
    for (const status of ['up', 'down', 'degraded', 'paused', 'pending']) {
      const meta = statusMeta(status);
      expect(meta.label).toBeTruthy();
      expect(meta.tone).toBe(status);
      expect(meta.color).toMatch(/^var\(--/);
    }
  });

  it('falls back safely for an unknown status', () => {
    const meta = statusMeta('exploded');
    expect(meta.label).toBe('exploded');
    expect(meta.tone).toBe('paused');
  });

  it('falls back safely for null', () => {
    expect(statusMeta(null).label).toBe('Unknown');
    expect(statusMeta(undefined).label).toBe('Unknown');
  });

  it('never returns an empty label', () => {
    for (const value of Object.keys(STATUS_META)) {
      expect(statusMeta(value).label).not.toBe('');
    }
  });
});

describe('chart colours', () => {
  it('has a colour for every status we render', () => {
    for (const status of ['up', 'down', 'degraded', 'paused', 'pending']) {
      expect(CHART_COLORS[status]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('range options', () => {
  it('offers the four supported ranges', () => {
    expect(RANGE_OPTIONS.map((o) => o.value)).toEqual(['1h', '24h', '7d', '30d']);
  });
});