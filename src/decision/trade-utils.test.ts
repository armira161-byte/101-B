import { describe, it, expect } from 'vitest';
import { avgRangeFromSnapshot, fallbackAtr } from './atr-fallback';
import { estimatedPatternMaturityBars } from './recommended-expiry';
import { estimateSpread } from './spread-estimate';
import type { IndicatorSnapshot, Tick } from '@/types/domain';

describe('avgRangeFromSnapshot', () => {
  it('computes average high-low range', () => {
    const candles = [
      { high: 12, low: 8 },
      { high: 14, low: 10 },
      { high: 11, low: 9 },
    ];
    expect(avgRangeFromSnapshot(candles, 3)).toBeCloseTo((4 + 4 + 2) / 3, 5);
  });

  it('returns 0 for empty array', () => {
    expect(avgRangeFromSnapshot([], 5)).toBe(0);
  });
});

describe('fallbackAtr', () => {
  it('uses snapshot ATR when available', () => {
    const snap = { atr: 3.5 } as IndicatorSnapshot;
    expect(fallbackAtr(snap, [], 14)).toBe(3.5);
  });

  it('falls back to avgRange when ATR is null', () => {
    const snap = { atr: null } as IndicatorSnapshot;
    const candles = [
      { high: 12, low: 8 },
      { high: 14, low: 10 },
    ];
    expect(fallbackAtr(snap, candles, 2)).toBeCloseTo(4, 5);
  });
});

describe('estimatedPatternMaturityBars', () => {
  it('returns at least 1 bar for low volatility', () => {
    const bars = estimatedPatternMaturityBars(0.001, 100);
    expect(bars).toBeGreaterThanOrEqual(1);
  });

  it('returns more bars for lower volatility', () => {
    const lowVol = estimatedPatternMaturityBars(0.001, 100);
    const highVol = estimatedPatternMaturityBars(2, 100);
    expect(lowVol).toBeGreaterThan(highVol);
  });

  it('adds a bar in range regime with a weak trend', () => {
    const base = estimatedPatternMaturityBars(0.001, 100, false);
    const withWeakTrend = estimatedPatternMaturityBars(0.001, 100, true);
    expect(withWeakTrend).toBe(base + 1);
  });
});

describe('estimateSpread', () => {
  it('uses live bid/ask when available', () => {
    const tick: Tick = { price: 100, time: 0, bid: 99.98, ask: 100.02 };
    const result = estimateSpread('BTCUSDT', tick);
    expect(result.source).toBe('live');
    expect(result.spread).toBeCloseTo(0.04, 5);
  });

  it('falls back to static estimate when no bid/ask', () => {
    const result = estimateSpread('BTCUSDT', null);
    expect(result.source).toBe('estimated');
    expect(result.spread).toBe(0.5);
  });

  it('falls back to 0 for unknown symbol', () => {
    const result = estimateSpread('UNKNOWN', null);
    expect(result.source).toBe('estimated');
    expect(result.spread).toBe(0);
  });

  it('uses estimated when bid/ask missing from tick', () => {
    const tick: Tick = { price: 100, time: 0 };
    const result = estimateSpread('EURUSD', tick);
    expect(result.source).toBe('estimated');
  });
});
