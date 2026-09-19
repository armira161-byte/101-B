import { describe, it, expect } from 'vitest';
import { computeBreakoutTradeLevels, computeLiquiditySweepTradeLevels, computeLiquiditySweepBaseTradeLevels, computeOrderBlockBreakerTradeLevels, computeStrongOrderBlockReactionTradeLevels, computeMacdDecelerationTradeLevels, computeFvgTradeLevels, computeOrderBlockNestedTradeLevels, computeCandlestickTradeLevels, computeThreeMethodsTradeLevels, computeTradeLevels } from '@/decision/trade-levels';

describe('computeBreakoutTradeLevels (Пункт 6 — structural SL/TP for impulse-breakout)', () => {
  it('places a buy stop below the breakout candle low, never inside its body', () => {
    // Breakout candle: low=99.8, high=104.3; entry at close=104.
    const levels = computeBreakoutTradeLevels(104, 'buy', 99.8, 104.3, 2);
    expect(levels.stopLoss).toBeLessThan(99.8);
  });

  it('places a sell stop above the breakout candle high, never inside its body', () => {
    const levels = computeBreakoutTradeLevels(96, 'sell', 95.7, 100.2, 2);
    expect(levels.stopLoss).toBeGreaterThan(100.2);
  });

  it('keeps R:R fixed at 2.0 regardless of how far the stop sits from entry', () => {
    const levels = computeBreakoutTradeLevels(104, 'buy', 99.8, 104.3, 2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });

  it('never places the stop inside the signal candle even at the shared atrMultiplier minimum (0.5), unlike the fixed-ATR stop it replaces', () => {
    // Breakout candle body is required to be >=1x ATR by the pattern's own
    // entry gate. At the old shared computeTradeLevels() with the user's
    // minimum atrMultiplier (0.5), the stop would land 0.5*ATR from entry —
    // inside a >=1*ATR candle body. computeBreakoutTradeLevels is immune to
    // this because it isn't parameterized by atrMultiplier at all; it's
    // anchored to the actual breakout candle extreme.
    const atrValue = 2;
    const entry = 104; // close
    const breakoutLow = 99.8; // candle body/range comfortably >1x ATR below entry
    const oldStyleStop = computeTradeLevels(entry, atrValue, 0.5, 'buy').stopLoss; // = 103
    expect(oldStyleStop).toBeGreaterThan(breakoutLow); // old stop sits inside the candle
    const newLevels = computeBreakoutTradeLevels(entry, 'buy', breakoutLow, 104.3, atrValue);
    expect(newLevels.stopLoss).toBeLessThan(breakoutLow); // new stop sits beyond it
  });
});

describe('computeLiquiditySweepTradeLevels (audit finding #6 — structural SL/TP for liquidity-sweep-reaction)', () => {
  it('places a buy stop below the sweep bar low, never at a fixed ATR distance from entry', () => {
    // Sweep bar: low=97.6, high=99.9. Entry (displacement close) at 100.5.
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, null, 1.2);
    expect(levels.stopLoss).toBeLessThan(97.6);
    expect(levels.stopLoss).toBeCloseTo(97.6 - 1.2 * 0.1, 6);
  });

  it('places a sell stop above the sweep bar high', () => {
    const levels = computeLiquiditySweepTradeLevels(99.5, 'sell', 99.6, 102.4, null, 1.2);
    expect(levels.stopLoss).toBeGreaterThan(102.4);
    expect(levels.stopLoss).toBeCloseTo(102.4 + 1.2 * 0.1, 6);
  });

  it('falls back to 2x stopDistance when no opposite zone is supplied', () => {
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, null, 1.2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });

  it('targets the nearest opposite liquidity zone when it clears the minimum R:R', () => {
    // Stop distance ≈ 100.5 - (97.6 - 0.12) = 3.02. A zone at 110 gives
    // reward ≈ 9.5, RR ≈ 3.15 — comfortably above the 1.5 minimum.
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, 110, 1.2);
    expect(levels.takeProfit).toBe(110);
  });

  it('falls back to 2x stopDistance when the opposite zone is too close for the minimum R:R', () => {
    // Zone at 101 gives reward ≈ 0.5 against a stop distance ≈ 3.02 — RR well
    // under 1.5, so the structural target must be rejected in favor of the
    // fallback (which is always exactly RR=2.0 by construction).
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, 101, 1.2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
    expect(levels.takeProfit).not.toBe(101);
  });

  it('mirrors zone-target selection for sell trades (zone must be below entry)', () => {
    // Stop distance ≈ (102.4 + 0.12) - 99.5 = 3.02. Zone at 90 gives
    // reward ≈ 9.5 → RR ≈ 3.15, clears the minimum.
    const levels = computeLiquiditySweepTradeLevels(99.5, 'sell', 99.6, 102.4, 90, 1.2);
    expect(levels.takeProfit).toBe(90);
  });
});

describe("computeLiquiditySweepBaseTradeLevels (Фаза 0' группа 2, редакция 3 — setupType-branched target for base liquidity-sweep)", () => {
  it('stop geometry is identical to computeLiquiditySweepTradeLevels for either setupType', () => {
    const buyContinuation = computeLiquiditySweepBaseTradeLevels(100.5, 'buy', 'continuation', 97.6, 99.9, null, 200, 50, 1.2);
    const buyReversal = computeLiquiditySweepBaseTradeLevels(100.5, 'buy', 'reversal-at-key-level', 97.6, 99.9, null, 200, 50, 1.2);
    expect(buyContinuation.stopLoss).toBeCloseTo(97.6 - 1.2 * 0.1, 6);
    expect(buyReversal.stopLoss).toBeCloseTo(97.6 - 1.2 * 0.1, 6);
  });

  it("setupType='continuation': targets nearestOppositeZone via smartMoney, ignoring rangeHigh/rangeLow entirely", () => {
    // Stop distance ≈ 100.5 - (97.6 - 0.12) = 3.02. rangeHigh=105 would also
    // clear RR if it were (wrongly) used — the assertion below proves the
    // zone (110), not the range boundary, is what's actually returned.
    const levels = computeLiquiditySweepBaseTradeLevels(100.5, 'buy', 'continuation', 97.6, 99.9, 110, 105, 50, 1.2);
    expect(levels.takeProfit).toBe(110);
  });

  it("setupType='reversal-at-key-level' (buy = Wyckoff Spring): targets rangeHigh, ignoring nearestOppositeZone entirely", () => {
    // Stop distance ≈ 3.02, same as above. nearestOppositeZone=999 would
    // trivially clear RR if it were (wrongly) used instead of the range.
    const levels = computeLiquiditySweepBaseTradeLevels(100.5, 'buy', 'reversal-at-key-level', 97.6, 99.9, 999, 110, 50, 1.2);
    expect(levels.takeProfit).toBe(110);
  });

  it("setupType='reversal-at-key-level' (sell = Wyckoff Upthrust): targets rangeLow", () => {
    // Sell sweep: sweepBarLow=99.6, sweepBarHigh=102.4, entry=99.5. Stop
    // distance ≈ (102.4 + 0.12) - 99.5 = 3.02. rangeLow=90 well clears RR.
    const levels = computeLiquiditySweepBaseTradeLevels(99.5, 'sell', 'reversal-at-key-level', 99.6, 102.4, 999, 150, 90, 1.2);
    expect(levels.takeProfit).toBe(90);
  });

  it('falls back to 2x stopDistance when the reversal-at-key-level Trading Range boundary is too close for the minimum R:R', () => {
    // rangeHigh=101 gives reward ≈ 0.5 against a stop distance ≈ 3.02 — RR
    // well under 1.5, must fall back exactly like the continuation/zone case.
    const levels = computeLiquiditySweepBaseTradeLevels(100.5, 'buy', 'reversal-at-key-level', 97.6, 99.9, null, 101, 50, 1.2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
    expect(levels.takeProfit).not.toBe(101);
  });
});

describe("computeStrongOrderBlockReactionTradeLevels (Фаза 0' группа 2 — sltp-geometry-source-variant-A.md §1)", () => {
  it('buy: places the stop beyond the reacting block bottom, not a fixed ATR multiple', () => {
    const levels = computeStrongOrderBlockReactionTradeLevels(109, 'buy', 100, 107, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(100 - 1.2 * 0.1, 6);
  });

  it('sell: places the stop beyond the reacting block top', () => {
    const levels = computeStrongOrderBlockReactionTradeLevels(91, 'sell', 93, 100, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(100 + 1.2 * 0.1, 6);
  });

  it('targets the nearest opposite smartMoney zone when it clears the minimum R:R, else falls back to 2x stopDistance', () => {
    const withZone = computeStrongOrderBlockReactionTradeLevels(109, 'buy', 100, 107, 130, 1.2);
    expect(withZone.takeProfit).toBe(130);

    const withoutZone = computeStrongOrderBlockReactionTradeLevels(109, 'buy', 100, 107, null, 1.2);
    const risk = Math.abs(withoutZone.entry - withoutZone.stopLoss);
    const reward = Math.abs(withoutZone.takeProfit - withoutZone.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });
});

describe("computeMacdDecelerationTradeLevels (Фаза 0' группа 2 — pattern-audit-checklist.md)", () => {
  it('buy: places the stop beyond the pause candle low, not a fixed ATR multiple', () => {
    const levels = computeMacdDecelerationTradeLevels(109, 'buy', 105, 108, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(105 - 1.2 * 0.1, 6);
  });

  it('sell: places the stop beyond the pause candle high', () => {
    const levels = computeMacdDecelerationTradeLevels(91, 'sell', 92, 95, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(95 + 1.2 * 0.1, 6);
  });

  it('targets the nearest structural level via smartMoney when it clears the minimum R:R, else falls back to 2x stopDistance', () => {
    const withZone = computeMacdDecelerationTradeLevels(109, 'buy', 105, 108, 130, 1.2);
    expect(withZone.takeProfit).toBe(130);

    const withoutZone = computeMacdDecelerationTradeLevels(109, 'buy', 105, 108, null, 1.2);
    const risk = Math.abs(withoutZone.entry - withoutZone.stopLoss);
    const reward = Math.abs(withoutZone.takeProfit - withoutZone.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });
});

describe("computeThreeMethodsTradeLevels (Фаза 0' группа 4 — Rising/Falling Three Methods measure rule)", () => {
  it('buy: places the stop beyond the 4-candle formation low, not a fixed ATR multiple', () => {
    const levels = computeThreeMethodsTradeLevels(105, 'buy', 98, 104, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(98 - 1.2 * 0.1, 6);
  });

  it('sell: places the stop beyond the 4-candle formation high', () => {
    const levels = computeThreeMethodsTradeLevels(95, 'sell', 96, 102, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(102 + 1.2 * 0.1, 6);
  });

  it('targets the precomputed measured-move projection when it clears the minimum R:R', () => {
    // Stop distance ≈ 105 - (98 - 0.12) = 7.12; target 130 gives RR ≈ 3.5.
    const levels = computeThreeMethodsTradeLevels(105, 'buy', 98, 104, 130, 1.2);
    expect(levels.takeProfit).toBe(130);
  });

  it('falls back to 2x stopDistance when the measured move is too small for the minimum R:R (disproportionately small impulse candle)', () => {
    // Impulse candle body was tiny relative to the whole formation's range,
    // so the measure-rule target sits well inside the minimum R:R —
    // the shared fallback must take over rather than emit a sub-1.5R trade.
    const levels = computeThreeMethodsTradeLevels(105, 'buy', 98, 104, 106, 1.2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
    expect(levels.takeProfit).not.toBe(106);
  });
});

describe("computeCandlestickTradeLevels (Фаза 0' группа 3 — shared by the classic Price Action candlestick family)", () => {
  it('buy: places the stop beyond the formation low, not a fixed ATR multiple', () => {
    const levels = computeCandlestickTradeLevels(88, 'buy', 84, 88.05, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(84 - 1.2 * 0.1, 6);
  });

  it('sell: places the stop beyond the formation high', () => {
    const levels = computeCandlestickTradeLevels(111, 'sell', 110.9, 116, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(116 + 1.2 * 0.1, 6);
  });

  it('targets the precomputed structural/measured-move candidate when it clears the minimum R:R, else falls back to 2x stopDistance', () => {
    const withTarget = computeCandlestickTradeLevels(88, 'buy', 84, 88.05, 112, 1.2);
    expect(withTarget.takeProfit).toBe(112);

    const withoutTarget = computeCandlestickTradeLevels(88, 'buy', 84, 88.05, null, 1.2);
    const risk = Math.abs(withoutTarget.entry - withoutTarget.stopLoss);
    const reward = Math.abs(withoutTarget.takeProfit - withoutTarget.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });
});

describe("computeOrderBlockNestedTradeLevels (Фаза 0' группа 2 — OB counterpart of computeFvgTradeLevels)", () => {
  it('buy: places the stop beyond the inner M1 OB boundary, not a fixed ATR multiple', () => {
    const levels = computeOrderBlockNestedTradeLevels(100.3, 'buy', 99.9, 100.2, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(99.9 - 1.2 * 0.1, 6);
  });

  it('sell: places the stop beyond the inner M1 OB top', () => {
    const levels = computeOrderBlockNestedTradeLevels(99.7, 'sell', 99.8, 100.1, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(100.1 + 1.2 * 0.1, 6);
  });

  it('targets the containing HTF zone boundary when it clears the minimum R:R, else falls back to 2x stopDistance', () => {
    const withTarget = computeOrderBlockNestedTradeLevels(100.3, 'buy', 99.9, 100.2, 120, 1.2);
    expect(withTarget.takeProfit).toBe(120);

    const withoutTarget = computeOrderBlockNestedTradeLevels(100.3, 'buy', 99.9, 100.2, null, 1.2);
    const risk = Math.abs(withoutTarget.entry - withoutTarget.stopLoss);
    const reward = Math.abs(withoutTarget.takeProfit - withoutTarget.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });
});

describe("computeFvgTradeLevels (Фаза 0' группа 2 — shared by fvg-return/fvg-rejection/fvg-breaker-block/fvg-nested)", () => {
  it('buy: places the stop beyond the FVG zone bottom, not a fixed ATR multiple', () => {
    const levels = computeFvgTradeLevels(106, 'buy', 104, 105, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(104 - 1.2 * 0.1, 6);
  });

  it('sell: places the stop beyond the FVG zone top', () => {
    const levels = computeFvgTradeLevels(94, 'sell', 95, 96, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(96 + 1.2 * 0.1, 6);
  });

  it('targets the precomputed structural candidate (smartMoney zone or HTF boundary) when it clears the minimum R:R, else falls back to 2x stopDistance', () => {
    const withTarget = computeFvgTradeLevels(106, 'buy', 104, 105, 130, 1.2);
    expect(withTarget.takeProfit).toBe(130);

    const withoutTarget = computeFvgTradeLevels(106, 'buy', 104, 105, null, 1.2);
    const risk = Math.abs(withoutTarget.entry - withoutTarget.stopLoss);
    const reward = Math.abs(withoutTarget.takeProfit - withoutTarget.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });
});

describe("computeOrderBlockBreakerTradeLevels (Фаза 0' группа 2 — sltp-geometry-source-variant-A.md §1)", () => {
  it('places the stop beyond the liquidity-sweep candle that broke the origin OB, not a fixed ATR multiple', () => {
    // sweepWickLow/High here stand in for the actual break candle's
    // low/high — deliberately different from any "OB zone" numbers to make
    // clear this isn't the breaker zone's own top/bottom.
    const levels = computeOrderBlockBreakerTradeLevels(106.3, 'buy', 104.1, 106.5, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(104.1 - 1.2 * 0.1, 6);
  });

  it('mirrors the sell-side stop beyond the sweep candle high', () => {
    const levels = computeOrderBlockBreakerTradeLevels(93.7, 'sell', 93.5, 95.9, null, 1.2);
    expect(levels.stopLoss).toBeCloseTo(95.9 + 1.2 * 0.1, 6);
  });

  it('targets the nearest opposite smartMoney zone when it clears the minimum R:R, else falls back to 2x stopDistance', () => {
    const withZone = computeOrderBlockBreakerTradeLevels(106.3, 'buy', 104.1, 106.5, 120, 1.2);
    expect(withZone.takeProfit).toBe(120);

    const withoutZone = computeOrderBlockBreakerTradeLevels(106.3, 'buy', 104.1, 106.5, null, 1.2);
    const risk = Math.abs(withoutZone.entry - withoutZone.stopLoss);
    const reward = Math.abs(withoutZone.takeProfit - withoutZone.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });
});
