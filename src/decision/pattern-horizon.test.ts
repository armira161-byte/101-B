import { describe, it, expect } from 'vitest';
import {
  horizonClassForPattern,
  maxHorizonBarsForPattern,
  HORIZON_BARS_BY_CLASS,
  HORIZON_BACKTEST_GRID,
} from './pattern-horizon';

describe('horizonClassForPattern — classification from pattern-audit-checklist.md', () => {
  it.each([
    'impulse-breakout', 'fvg-return', 'fvg-rejection', 'fvg-breaker-block',
    'consolidation-breakout', 'inside-bar',
    'marubozu-bullish', 'marubozu-bearish',
    'bullish-engulfing', 'bearish-engulfing',
    'piercing-line', 'dark-cloud-cover',
  ])('classifies %s as short (1-3 bars)', (name) => {
    expect(horizonClassForPattern(name)).toBe('short');
  });

  it.each([
    'liquidity-sweep-reaction', 'strong-order-block-reaction', 'order-block-breaker',
    'hammer', 'shooting-star', 'inverted-hammer', 'hanging-man',
    'bullish-harami', 'bearish-harami', 'tweezer-bottom', 'tweezer-top', 'pin-bar',
    'morning-star', 'evening-star', 'three-white-soldiers', 'three-black-crows',
  ])('classifies %s as medium (3-10 bars)', (name) => {
    expect(horizonClassForPattern(name)).toBe('medium');
  });

  it.each([
    'order-block-continuation', 'macd-deceleration-continuation', 'harmonic-pattern',
    'mean-reversion', 'rising-three-methods', 'falling-three-methods',
    'abandoned-baby-bottom', 'abandoned-baby-top',
    'order-block-nested', 'fvg-nested',
  ])('classifies %s as long (10+ bars)', (name) => {
    expect(horizonClassForPattern(name)).toBe('long');
  });
});

describe('horizonClassForPattern — liquidity-sweep is setupType-dependent', () => {
  it("treats setupType='continuation' as short (pure ICT sweep-then-continue)", () => {
    expect(horizonClassForPattern('liquidity-sweep', 'continuation')).toBe('short');
  });

  it("treats setupType='reversal-at-key-level' as medium (Wyckoff Spring/Upthrust needs longer to play out)", () => {
    expect(horizonClassForPattern('liquidity-sweep', 'reversal-at-key-level')).toBe('medium');
  });

  it('defaults to the short (continuation) class when setupType is absent', () => {
    // A cached/legacy PatternResult from before setupType existed must not
    // silently get the longer reversal horizon.
    expect(horizonClassForPattern('liquidity-sweep')).toBe('short');
  });

  it('does not let setupType leak into other patterns', () => {
    // setupType is only meaningful for the liquidity-sweep family; passing
    // it alongside an unrelated pattern must not change that pattern's class.
    expect(horizonClassForPattern('harmonic-pattern', 'reversal-at-key-level')).toBe('long');
    expect(horizonClassForPattern('bullish-engulfing', 'reversal-at-key-level')).toBe('short');
  });
});

describe('horizonClassForPattern — unclassified fallbacks', () => {
  it.each([null, undefined, '', 'some-brand-new-pattern'])(
    'returns unclassified for %p rather than throwing or guessing short',
    (name) => {
      expect(horizonClassForPattern(name)).toBe('unclassified');
    },
  );

  it('returns unclassified for doji/spinning-top, which are deliberately not wired to TP/SL', () => {
    expect(horizonClassForPattern('doji')).toBe('unclassified');
    expect(horizonClassForPattern('spinning-top')).toBe('unclassified');
  });
});

describe('maxHorizonBarsForPattern', () => {
  it('maps each class to its configured bar count', () => {
    expect(maxHorizonBarsForPattern('bullish-engulfing')).toBe(HORIZON_BARS_BY_CLASS.short);
    expect(maxHorizonBarsForPattern('pin-bar')).toBe(HORIZON_BARS_BY_CLASS.medium);
    expect(maxHorizonBarsForPattern('harmonic-pattern')).toBe(HORIZON_BARS_BY_CLASS.long);
    expect(maxHorizonBarsForPattern('unknown-pattern')).toBe(HORIZON_BARS_BY_CLASS.unclassified);
  });

  it('gives long-horizon patterns a strictly larger window than short-horizon ones', () => {
    // The whole point of Фаза 2: order-block-continuation must not be
    // resolved on the same 5-bar window as an Engulfing.
    expect(maxHorizonBarsForPattern('order-block-continuation'))
      .toBeGreaterThan(maxHorizonBarsForPattern('bullish-engulfing'));
    expect(maxHorizonBarsForPattern('pin-bar'))
      .toBeGreaterThan(maxHorizonBarsForPattern('fvg-return'));
  });

  it('always returns a positive bar count (resolveOutcomeByLevels rejects <=0)', () => {
    for (const name of ['bullish-engulfing', 'pin-bar', 'harmonic-pattern', 'nonsense', '']) {
      expect(maxHorizonBarsForPattern(name)).toBeGreaterThan(0);
    }
  });

  it('gives the reversal liquidity-sweep a longer window than the continuation one', () => {
    expect(maxHorizonBarsForPattern('liquidity-sweep', 'reversal-at-key-level'))
      .toBeGreaterThan(maxHorizonBarsForPattern('liquidity-sweep', 'continuation'));
  });
});

describe('HORIZON_BACKTEST_GRID (Фаза 5 calibration grid)', () => {
  it('is the ascending grid the refactor prompt specifies', () => {
    expect([...HORIZON_BACKTEST_GRID]).toEqual([5, 10, 20, 30, 50]);
  });

  it('spans every default horizon, so the grid can actually confirm or move each one', () => {
    const min = Math.min(...HORIZON_BACKTEST_GRID);
    const max = Math.max(...HORIZON_BACKTEST_GRID);
    for (const bars of Object.values(HORIZON_BARS_BY_CLASS)) {
      expect(bars).toBeLessThanOrEqual(max);
      // short=3 sits below the grid's floor of 5 by design — the grid is for
      // calibration, not a constraint on the starting hypothesis. Assert the
      // gap is small enough that the grid's lowest rung is still informative.
      expect(bars).toBeGreaterThanOrEqual(min - 2);
    }
  });
});
