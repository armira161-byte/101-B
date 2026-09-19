import { describe, it, expect } from 'vitest';
import type { Signal } from '@/types/domain';
import { applySpreadToOutcome } from './apply-spread';

// BUGFIX (Фаза 5, попутно обнаружено при переписывании этого файла): эта
// фикстура была рассинхронизирована с текущим Signal (types/domain.ts) ещё
// ДО варианта А — не хватало обязательных stopLoss/takeProfit/
// recommendedExpiry, а вместо них были поля expiryBars/
// estimatedPatternMaturityBars, которых в Signal вообще не существует.
// Приведено к тому же (актуальному) шаблону, что уже использует
// outcome-scheduler.test.ts — там он был исправлен в Фазе 3.
function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    symbolId: 'BTCUSDT',
    timeframe: '5m',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: null,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    reason: 'test',
    indicators: {} as unknown as Signal['indicators'],
    pattern: null,
    time: 1000,
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 300,
    featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

// Refactor variant A, Фаза 5 — переписано под новую сигнатуру
// (resolved.exitPrice/exitReason вместо голого outcome+expiryClosePrice) и
// новую семантику: спред больше НИКОГДА не понижает 'win'/'loss' (они уже
// построены с запасом buffer×ATR поверх спреда самой геометрией паттерна),
// он только помечает "плоский" timeout через isFlatTimeout — outcome сам
// по себе не меняется. См. комментарий в apply-spread.ts.
describe('applySpreadToOutcome', () => {
  it('does NOT downgrade a real take-profit touch even when the move barely exceeds the spread', () => {
    const signal = makeSignal({ id: 'sig-1', entryPrice: 100 });
    // Реальное касание take-profit — движение всего 0.4 при спреде 0.5:
    // раньше это понизило бы outcome, теперь take_profit уже означает
    // подтверждённое касание уровня и не пересматривается по спреду.
    const result = applySpreadToOutcome(
      { outcome: 'win', exitPrice: 100.4, exitReason: 'take_profit' },
      signal,
      0.5,
    );

    expect(result.outcome).toBe('win');
    expect(result.isFlatTimeout).toBe(false);
  });

  it('keeps a win when the move comfortably exceeds the spread', () => {
    const signal = makeSignal({ id: 'sig-2', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'win', exitPrice: 102, exitReason: 'take_profit' },
      signal,
      0.5,
    );

    expect(result.outcome).toBe('win');
    expect(result.isFlatTimeout).toBe(false);
  });

  it('never flags a loss (stop_loss exit) as a flat timeout, regardless of the move size', () => {
    const signal = makeSignal({ id: 'sig-3', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'loss', exitPrice: 99.9, exitReason: 'stop_loss' },
      signal,
      0.5,
    );

    expect(result.outcome).toBe('loss');
    expect(result.isFlatTimeout).toBe(false);
  });

  it('flags a timeout as flat when the move at exit does not exceed the spread', () => {
    const signal = makeSignal({ id: 'sig-4', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'timeout', exitPrice: 100.3, exitReason: 'timeout' },
      signal,
      0.5,
    );

    expect(result.outcome).toBe('timeout');
    expect(result.isFlatTimeout).toBe(true);
  });

  it('does not flag a timeout as flat when the move at exit exceeds the spread', () => {
    const signal = makeSignal({ id: 'sig-5', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'timeout', exitPrice: 103, exitReason: 'timeout' },
      signal,
      0.5,
    );

    expect(result.outcome).toBe('timeout');
    expect(result.isFlatTimeout).toBe(false);
  });

  it('computes spreadCostR as spread divided by the actual price move', () => {
    const signal = makeSignal({ id: 'sig-6', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'win', exitPrice: 102, exitReason: 'take_profit' },
      signal,
      0.5,
    );

    expect(result.spreadCostR).toBeCloseTo(0.5 / 2, 5);
  });

  it('returns spreadCostR of 0 when there is no price move at all', () => {
    const signal = makeSignal({ id: 'sig-7', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'timeout', exitPrice: 100, exitReason: 'timeout' },
      signal,
      0.5,
    );

    expect(result.spreadCostR).toBe(0);
  });

  it('treats a timeout move exactly equal to the spread as flat (boundary, move <= spread)', () => {
    const signal = makeSignal({ id: 'sig-8', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'timeout', exitPrice: 100.5, exitReason: 'timeout' },
      signal,
      0.5,
    );

    expect(result.isFlatTimeout).toBe(true);
  });

  it('does not flag a timeout as flat when spread is zero/unknown', () => {
    const signal = makeSignal({ id: 'sig-9', entryPrice: 100 });
    const result = applySpreadToOutcome(
      { outcome: 'timeout', exitPrice: 100, exitReason: 'timeout' },
      signal,
      0,
    );

    expect(result.isFlatTimeout).toBe(false);
  });
});
