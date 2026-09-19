import { describe, it, expect } from 'vitest';
import type { Candle, Signal } from '@/types/domain';
import { OutcomeScheduler, resolveOutcome } from './outcome-scheduler';

function makeSignal(overrides: Partial<Signal> & { id: string; time: number }): Signal {
  return {
    symbolId: 'A', timeframe: '5m', direction: 'buy', strength: 'moderate',
    score: 3, calibratedProbability: null, entryPrice: 100, stopLoss: 95,
    takeProfit: 110, reason: 'test', indicators: {} as unknown as Signal['indicators'],
    pattern: null, outcome: 'pending', frozenAt: null, isRevised: false,
    isPreClose: false, revisionNote: null, barsToResolve: 5, spread: null,
    spreadSource: null, recommendedExpiry: 300, featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

function candle(time: number, close: number, high: number, low: number): Candle {
  return { time, open: close, high, low, close, volume: 100 };
}

describe('OutcomeScheduler.schedule — dedup by signal.id', () => {
  it('only tracks one pending entry when schedule() is called twice for the same signal.id', () => {
    // Воспроизводит реальный сценарий: pre-close (maybeTriggerPreClose)
    // и подстраховка в maybeEvaluateSignal (isClosed === true) для одной и
    // той же свечи оба вызывают scheduler.schedule(signal) с одинаковым
    // signal.id (см. generateSignalId — id детерминирован по
    // symbolId:timeframe:candleTime).
    const scheduler = new OutcomeScheduler();
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000 });
    const signalCopy = makeSignal({ id: 'A:5m:1000', time: 1000 }); // другой объект, тот же id

    scheduler.schedule(signal);
    scheduler.schedule(signalCopy);

    expect(scheduler.getPendingCount()).toBe(1);
  });

  it('does not call onResolve twice for the same signal.id once outcome is reached', () => {
    const scheduler = new OutcomeScheduler();
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000, direction: 'buy', takeProfit: 110, stopLoss: 95, barsToResolve: 3 });
    const signalCopy = makeSignal({ id: 'A:5m:1000', time: 1000, direction: 'buy', takeProfit: 110, stopLoss: 95, barsToResolve: 3 });

    scheduler.schedule(signal);
    scheduler.schedule(signalCopy);

    const resolvedCalls: Array<{ signalId: string; outcome: string }> = [];
    const allCandles = [candle(1000, 100, 101, 99), candle(1300, 111, 112, 108)];

    scheduler.onCandleClosed(allCandles, (resolved) => {
      resolvedCalls.push({ signalId: resolved.signalId, outcome: resolved.outcome });
    });

    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
    expect(scheduler.getPendingCount()).toBe(0);
  });

  it('still tracks two distinct signals with different ids independently', () => {
    const scheduler = new OutcomeScheduler();
    scheduler.schedule(makeSignal({ id: 'A:5m:1000', time: 1000 }));
    scheduler.schedule(makeSignal({ id: 'A:5m:1300', time: 1300 }));

    expect(scheduler.getPendingCount()).toBe(2);
  });

  it('updates tradeOpened from false to true when schedule() is called again with the same id', () => {
    // Воспроизводит баг расхождения "Последние сделки" vs "История сигналов":
    // pre-close кладёт сигнал с tradeOpened: false (сделка не открылась из-за
    // guard'а "одна сделка на инструмент"), затем при реальном закрытии
    // свечи maybeEvaluateSignal открывает сделку и вызывает schedule() с
    // tradeOpened: true. Без обновления в очереди остаётся устаревший false,
    // и maybeResolveOutcomes позже перезапишет корректный исход от
    // useDemoAccountStore своим собственным (неправильным).
    const scheduler = new OutcomeScheduler();
    const signalNotTraded = makeSignal({ id: 'A:5m:1000', time: 1000, tradeOpened: false });
    const signalTraded = makeSignal({ id: 'A:5m:1000', time: 1000, tradeOpened: true });

    scheduler.schedule(signalNotTraded);
    scheduler.schedule(signalTraded);

    expect(scheduler.getPendingCount()).toBe(1);
    const pending = scheduler.getPendingList();
    expect(pending[0].signal.tradeOpened).toBe(true);
  });
});

// Refactor variant A, Фаза 3: resolveOutcome снова резолвит по КАСАНИЮ
// stopLoss/takeProfit, но теперь через тот же общий resolve-by-levels.ts,
// что использует и бэктест, и (после Фазы 4) демо-счёт. Предыдущая
// редакция этих тестов фиксировала промежуточную close-модель ("исход по
// цене закрытия ровно следующей свечи") — она сведена наверх, к резолву по
// уровням, чтобы не расходиться с геометрией SL/TP всех 33 паттернов
// (Фаза 0'). Тесты ниже переписаны под новую семантику, а не удалены:
// каждый прежний кейс сохранён как проверка ПРОТИВОПОЛОЖНОГО ожидания —
// это и есть содержательная разница между моделями.
describe('resolveOutcome — resolves by stopLoss/takeProfit touch over signal.barsToResolve', () => {
  it('returns "loss" for a buy whose low touched stopLoss, even though that candle CLOSED above entry', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    // Low (94) dips below stopLoss (95) intrabar. The close (101) is above
    // entry, so the previous close-model called this a 'win' — under the
    // level-touch model the stop was really hit and this is a loss.
    const candlesAfter = [candle(1300, 101, 102, 94)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved?.outcome).toBe('loss');
    expect(resolved?.exitPrice).toBe(95);
    expect(resolved?.exitReason).toBe('stop_loss');
    expect(resolved?.barsHeld).toBe(1);
  });

  it('stays pending (null) when a candle closes above entry but neither level was touched', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    // Close (100.5) is above entry but nowhere near takeProfit (110), and
    // the low never reached the stop. The close-model resolved this
    // immediately as a 'win'; the level-touch model must keep waiting —
    // the trade genuinely has not hit either exit yet.
    const candlesAfter = [candle(1300, 100.5, 100.6, 100.2)];

    expect(resolveOutcome(signal, candlesAfter)).toBeNull();
  });

  it('keeps scanning later candles within barsToResolve instead of locking in the first one', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    // First candle closes below entry but touches neither level — the
    // close-model locked in a 'loss' here. A later candle inside the
    // horizon reaches takeProfit, which is the real outcome.
    const candlesAfter = [
      candle(1300, 98, 99, 96),
      candle(1600, 112, 120, 111),
    ];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved?.outcome).toBe('win');
    expect(resolved?.exitPrice).toBe(110);
    expect(resolved?.barsHeld).toBe(2);
  });

  it('returns "timeout" once barsToResolve candles pass with neither level touched', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 3,
    });
    const candlesAfter = [
      candle(1300, 100.5, 101, 99.5),
      candle(1600, 101, 102, 99.8),
      candle(1900, 100.2, 101, 99.6),
    ];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved?.outcome).toBe('timeout');
    expect(resolved?.exitReason).toBe('timeout');
    expect(resolved?.exitPrice).toBe(100.2); // close of the last horizon candle
    expect(resolved?.barsHeld).toBe(3);
  });

  it('honours the per-pattern horizon carried on the signal, not a global constant', () => {
    // Same candles, two signals differing ONLY in barsToResolve (Фаза 2
    // sets this per pattern). The short-horizon one must time out before
    // reaching the take-profit that the long-horizon one collects.
    const candlesAfter = [
      candle(1300, 100.5, 101, 99.5),
      candle(1600, 112, 120, 111),
    ];
    const shortHorizon = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 1,
    });
    const longHorizon = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });

    expect(resolveOutcome(shortHorizon, candlesAfter)?.outcome).toBe('timeout');
    expect(resolveOutcome(longHorizon, candlesAfter)?.outcome).toBe('win');
  });

  it('mirrors the level-touch logic for sells (stop above, target below)', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'sell',
      entryPrice: 100, stopLoss: 105, takeProfit: 90, barsToResolve: 5,
    });
    // High (106) touches the stop; the close-model would have judged this
    // by close vs entry instead.
    const candlesAfter = [candle(1300, 101, 106, 100.5)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved?.outcome).toBe('loss');
    expect(resolved?.exitPrice).toBe(105);
  });

  it('flags ambiguousIntrabarTouch and conservatively reports a loss when one candle touches BOTH levels', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    const candlesAfter = [candle(1300, 102, 115, 90)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved?.outcome).toBe('loss');
    expect(resolved?.ambiguousIntrabarTouch).toBe(true);
  });

  it('treats a non-positive barsToResolve on legacy records as 1 bar rather than hanging forever in pending', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 0,
    });
    const candlesAfter = [candle(1300, 100.5, 101, 99.5)];

    // Horizon coerced to 1 → one candle elapsed, neither level touched → timeout.
    expect(resolveOutcome(signal, candlesAfter)?.outcome).toBe('timeout');
  });

  it('returns null when the signal is not pending (already resolved)', () => {
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000, outcome: 'win' });
    const candlesAfter = [candle(1300, 101, 102, 99)];

    expect(resolveOutcome(signal, candlesAfter)).toBeNull();
  });

  it('returns null when there are no candles after the signal yet', () => {
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000 });

    expect(resolveOutcome(signal, [])).toBeNull();
  });
});
