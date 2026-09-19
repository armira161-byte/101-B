import { describe, it, expect } from 'vitest';
import type { Candle } from '@/types/domain';
import { resolveOutcomeByLevels, resolveOutcomeByTick, type ResolvableSignal } from './resolve-by-levels';

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 100 };
}

function buySignal(overrides: Partial<ResolvableSignal> = {}): ResolvableSignal {
  return { id: 's1', direction: 'buy', stopLoss: 95, takeProfit: 110, ...overrides };
}

function sellSignal(overrides: Partial<ResolvableSignal> = {}): ResolvableSignal {
  return { id: 's1', direction: 'sell', stopLoss: 110, takeProfit: 95, ...overrides };
}

describe('resolveOutcomeByLevels — take-profit hit first', () => {
  it('buy: resolves win on the first bar whose high reaches takeProfit', () => {
    const signal = buySignal();
    const candles = [
      candle(1, 100, 105, 99, 103), // neither level touched
      candle(2, 103, 111, 102, 108), // high >= 110 → TP
      candle(3, 108, 120, 107, 115), // would also hit TP — must not be reached
    ];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result).toEqual({
      signalId: 's1',
      outcome: 'win',
      exitPrice: 110,
      exitReason: 'take_profit',
      barsHeld: 2,
      ambiguousIntrabarTouch: false,
    });
  });

  it('sell: resolves win on the first bar whose low reaches takeProfit', () => {
    const signal = sellSignal();
    const candles = [
      candle(1, 100, 101, 96, 98),
      candle(2, 98, 99, 94, 96), // low <= 95 → TP for a sell
    ];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result?.outcome).toBe('win');
    expect(result?.exitPrice).toBe(95);
    expect(result?.exitReason).toBe('take_profit');
    expect(result?.barsHeld).toBe(2);
  });
});

describe('resolveOutcomeByLevels — stop-loss hit first', () => {
  it('buy: resolves loss on the first bar whose low reaches stopLoss', () => {
    const signal = buySignal();
    const candles = [
      candle(1, 100, 104, 96, 101),
      candle(2, 101, 103, 94, 95), // low <= 95 → SL
      candle(3, 95, 112, 94, 110), // would hit TP — must not be reached
    ];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result).toEqual({
      signalId: 's1',
      outcome: 'loss',
      exitPrice: 95,
      exitReason: 'stop_loss',
      barsHeld: 2,
      ambiguousIntrabarTouch: false,
    });
  });

  it('sell: resolves loss on the first bar whose high reaches stopLoss', () => {
    const signal = sellSignal();
    const candles = [candle(1, 100, 111, 99, 105)]; // high >= 110 → SL for a sell
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result?.outcome).toBe('loss');
    expect(result?.exitPrice).toBe(110);
    expect(result?.exitReason).toBe('stop_loss');
  });
});

describe('resolveOutcomeByLevels — ambiguous intrabar touch (both levels hit on the same candle)', () => {
  it('conservatively counts as a loss and flags ambiguousIntrabarTouch', () => {
    const signal = buySignal(); // SL=95, TP=110
    const candles = [candle(1, 100, 115, 90, 102)]; // high>=110 AND low<=95, same bar
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result).toEqual({
      signalId: 's1',
      outcome: 'loss',
      exitPrice: 95,
      exitReason: 'stop_loss',
      barsHeld: 1,
      ambiguousIntrabarTouch: true,
    });
  });

  it('does not flag ambiguity on a later bar once an earlier bar already resolved the trade', () => {
    const signal = buySignal();
    const candles = [
      candle(1, 100, 111, 99, 108), // TP hit cleanly first
      candle(2, 108, 115, 90, 100), // this bar alone would be ambiguous, but is never reached
    ];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result?.ambiguousIntrabarTouch).toBe(false);
    expect(result?.barsHeld).toBe(1);
  });
});

describe('resolveOutcomeByLevels — timeout (horizon exhausted, neither level touched)', () => {
  it('resolves timeout at the close of the last horizon candle once maxHorizonBars candles have elapsed', () => {
    const signal = buySignal(); // SL=95, TP=110
    const candles = [
      candle(1, 100, 105, 98, 102),
      candle(2, 102, 106, 99, 104),
      candle(3, 104, 107, 100, 105),
    ];
    const result = resolveOutcomeByLevels(signal, candles, 3);
    expect(result).toEqual({
      signalId: 's1',
      outcome: 'timeout',
      exitPrice: 105, // close of the 3rd (last horizon) candle
      exitReason: 'timeout',
      barsHeld: 3,
      ambiguousIntrabarTouch: false,
    });
  });

  it('ignores candles beyond maxHorizonBars when computing the timeout exit price', () => {
    const signal = buySignal();
    const candles = [
      candle(1, 100, 105, 98, 102),
      candle(2, 102, 106, 99, 104),
      candle(3, 104, 200, 100, 200), // beyond the horizon — must be ignored entirely, even though it would hit TP
    ];
    const result = resolveOutcomeByLevels(signal, candles, 2);
    expect(result?.outcome).toBe('timeout');
    expect(result?.exitPrice).toBe(104); // close of 2nd candle, not the 3rd
    expect(result?.barsHeld).toBe(2);
  });
});

describe('resolveOutcomeByLevels — still pending (not enough candles yet, horizon not exhausted)', () => {
  it('returns null when fewer candles than maxHorizonBars have elapsed and neither level was touched', () => {
    const signal = buySignal();
    const candles = [candle(1, 100, 105, 98, 102)];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result).toBeNull();
  });

  it('returns null with zero candles after the signal', () => {
    const signal = buySignal();
    const result = resolveOutcomeByLevels(signal, [], 5);
    expect(result).toBeNull();
  });

  it('returns null for a degenerate maxHorizonBars<=0 instead of throwing', () => {
    const signal = buySignal();
    expect(resolveOutcomeByLevels(signal, [candle(1, 100, 105, 98, 102)], 0)).toBeNull();
    expect(resolveOutcomeByLevels(signal, [], 0)).toBeNull();
  });
});

describe('resolveOutcomeByLevels — boundary (exact) touches', () => {
  it('buy: a high exactly equal to takeProfit counts as a hit, not a near-miss', () => {
    const signal = buySignal(); // TP=110
    const candles = [candle(1, 100, 110, 99, 105)];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result?.outcome).toBe('win');
  });

  it('buy: a low exactly equal to stopLoss counts as a hit, not a near-miss', () => {
    const signal = buySignal(); // SL=95
    const candles = [candle(1, 100, 104, 95, 99)];
    const result = resolveOutcomeByLevels(signal, candles, 5);
    expect(result?.outcome).toBe('loss');
  });
});

describe('resolveOutcomeByTick — live check of the currently forming candle (Фаза 3)', () => {
  it('buy: resolves win when the bid reaches takeProfit', () => {
    const result = resolveOutcomeByTick(buySignal(), { price: 110.5, bid: 110.2, ask: 110.8 });
    expect(result?.outcome).toBe('win');
    expect(result?.exitPrice).toBe(110);
    expect(result?.exitReason).toBe('take_profit');
  });

  it('buy: resolves loss when the bid reaches stopLoss', () => {
    const result = resolveOutcomeByTick(buySignal(), { price: 95.3, bid: 94.9, ask: 95.6 });
    expect(result?.outcome).toBe('loss');
    expect(result?.exitPrice).toBe(95);
    expect(result?.exitReason).toBe('stop_loss');
  });

  it('sell: uses the ASK side, not the mid price, to close the position', () => {
    // sell SL=110. Mid price 109.6 has NOT hit the stop, but the ask we
    // would actually buy back at (110.1) has — a mid-price check would
    // wrongly keep this trade open and overstate winRate.
    const result = resolveOutcomeByTick(sellSignal(), { price: 109.6, bid: 109.1, ask: 110.1 });
    expect(result?.outcome).toBe('loss');
    expect(result?.exitReason).toBe('stop_loss');
  });

  it('sell: resolves win when the ask reaches takeProfit', () => {
    const result = resolveOutcomeByTick(sellSignal(), { price: 95.2, bid: 94.7, ask: 94.9 });
    expect(result?.outcome).toBe('win');
    expect(result?.exitPrice).toBe(95);
  });

  it('falls back to tick.price when no bid/ask is available', () => {
    expect(resolveOutcomeByTick(buySignal(), { price: 111 })?.outcome).toBe('win');
    expect(resolveOutcomeByTick(buySignal(), { price: 94 })?.outcome).toBe('loss');
  });

  it('returns null when the tick sits between the levels (trade still open)', () => {
    expect(resolveOutcomeByTick(buySignal(), { price: 102, bid: 101.9, ask: 102.1 })).toBeNull();
    expect(resolveOutcomeByTick(sellSignal(), { price: 102, bid: 101.9, ask: 102.1 })).toBeNull();
  });

  it('counts the forming candle as one additional (unfinished) bar of holding', () => {
    expect(resolveOutcomeByTick(buySignal(), { price: 111 }, 0)?.barsHeld).toBe(1);
    expect(resolveOutcomeByTick(buySignal(), { price: 111 }, 3)?.barsHeld).toBe(4);
  });

  it('conservatively reports stop_loss and flags ambiguity if the levels themselves are corrupt (SL/TP crossed)', () => {
    // Degenerate signal: takeProfit below stopLoss for a buy — a single
    // tick can then satisfy both conditions. Must not silently report a win.
    const corrupt = buySignal({ stopLoss: 110, takeProfit: 95 });
    const result = resolveOutcomeByTick(corrupt, { price: 100 });
    expect(result?.outcome).toBe('loss');
    expect(result?.ambiguousIntrabarTouch).toBe(true);
  });
});
