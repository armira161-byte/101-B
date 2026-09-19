import { describe, it, expect } from 'vitest';
import { estimatedPatternMaturityBars } from './recommended-expiry';

describe('estimatedPatternMaturityBars', () => {
  it('returns 3 bars for very low volatility (< 0.5%)', () => {
    // volatilityPct = 0.4 / 100 = 0.004 < 0.005 → 3 bars
    expect(estimatedPatternMaturityBars(0.4, 100)).toBe(3);
  });

  it('returns 2 bars for medium volatility (0.5%-1%)', () => {
    // volatilityPct = 0.7 / 100 = 0.007 → 2 bars
    expect(estimatedPatternMaturityBars(0.7, 100)).toBe(2);
  });

  it('returns 1 bar for high volatility (> 1%)', () => {
    // volatilityPct = 2 / 100 = 0.02 → 1 bar
    expect(estimatedPatternMaturityBars(2, 100)).toBe(1);
  });

  it('returns 1 bar when atr is zero', () => {
    expect(estimatedPatternMaturityBars(0, 100)).toBe(1);
  });

  it('returns 1 bar when entryPrice is zero', () => {
    expect(estimatedPatternMaturityBars(1, 0)).toBe(1);
  });

  it('returns 1 bar when both atr and entryPrice are zero', () => {
    expect(estimatedPatternMaturityBars(0, 0)).toBe(1);
  });

  it('handles boundary at exactly 0.5% volatility', () => {
    // volatilityPct = 0.5 / 100 = 0.005 → NOT < 0.005, so 2 bars
    expect(estimatedPatternMaturityBars(0.5, 100)).toBe(2);
  });

  it('handles boundary at exactly 1% volatility', () => {
    // volatilityPct = 1 / 100 = 0.01 → NOT < 0.01, so 1 bar
    expect(estimatedPatternMaturityBars(1, 100)).toBe(1);
  });

  it('adds one extra bar in a weak-trend range regime', () => {
    expect(estimatedPatternMaturityBars(0.4, 100, true)).toBe(4);
    expect(estimatedPatternMaturityBars(2, 100, true)).toBe(2);
  });
});
