import { describe, it, expect } from 'vitest';
import type { Signal, SignalOutcome } from '@/types/domain';
import type { SimulatedTrade } from './simulator';
import { computeMetrics, computeSplitMetrics, computeMetricsBySession } from './metrics';

// Refactor variant A, Фаза 5 — прямое покрытие computeMetrics() на
// синтетических сделках с заранее известным rMultiple: раньше эта функция
// молча зависела от переданного извне profitPercent (BacktestMetrics.
// averageR вычислялся из хардкожённого payout, а не из реальной геометрии
// сделки), сейчас — от честного SimulatedTrade.rMultiple. Прямых тестов на
// этот файл раньше не было вообще (только косвенно через backtest.test.ts/
// change-registry.test.ts) — учитывая, что это финансовая метрика, стоит
// зафиксировать числа явно.
function makeTrade(
  outcome: SignalOutcome,
  rMultiple: number,
  overrides: Partial<Pick<SimulatedTrade, 'inSample' | 'entryTime' | 'signal'>> = {},
): SimulatedTrade {
  return {
    signal: { calibratedProbability: 0.6, time: 1_700_000_000, ...(overrides.signal ?? {}) } as unknown as Signal,
    outcome,
    entryTime: overrides.entryTime ?? 1_700_000_000,
    candleIndex: 0,
    spreadCostR: 0,
    rMultiple,
    inSample: overrides.inSample ?? true,
  };
}

describe('computeMetrics', () => {
  it('returns all-zero metrics for an empty trade list', () => {
    const m = computeMetrics([]);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.averageR).toBe(0);
    expect(m.averageWinR).toBe(0);
    expect(m.profitFactor).toBe(0);
    expect(m.maxDrawdownR).toBe(0);
    expect(m.maxConsecutiveLosses).toBe(0);
  });

  it('excludes timeouts from winRate (decided = wins + losses, not total)', () => {
    // 2 wins, 1 loss, 1 timeout — winRate must be 2/3, not 2/4.
    const trades = [
      makeTrade('win', 1.5),
      makeTrade('win', 2.0),
      makeTrade('loss', -1),
      makeTrade('timeout', 0),
    ];
    const m = computeMetrics(trades);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.timeouts).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3, 6);
  });

  it('computes averageR as the mean of real rMultiple across ALL trades (including timeouts)', () => {
    const trades = [makeTrade('win', 2), makeTrade('loss', -1), makeTrade('timeout', 0)];
    const m = computeMetrics(trades);
    // (2 + -1 + 0) / 3
    expect(m.averageR).toBeCloseTo(1 / 3, 6);
  });

  it('computes averageWinR as the mean rMultiple among wins only, ignoring losses/timeouts', () => {
    const trades = [makeTrade('win', 1.5), makeTrade('win', 2.5), makeTrade('loss', -1), makeTrade('timeout', 0)];
    const m = computeMetrics(trades);
    expect(m.averageWinR).toBeCloseTo(2.0, 6);
  });

  it('returns averageWinR of 0 when there are no wins', () => {
    const trades = [makeTrade('loss', -1), makeTrade('timeout', 0)];
    const m = computeMetrics(trades);
    expect(m.averageWinR).toBe(0);
  });

  it('computes profitFactor as gross positive R over absolute gross negative R', () => {
    // wins sum to 3 (2 + 1), losses sum to -2 (-1 + -1) -> profitFactor 1.5
    const trades = [makeTrade('win', 2), makeTrade('win', 1), makeTrade('loss', -1), makeTrade('loss', -1)];
    const m = computeMetrics(trades);
    expect(m.profitFactor).toBeCloseTo(1.5, 6);
  });

  it('returns Infinity profitFactor when there are wins but zero losses', () => {
    const trades = [makeTrade('win', 1), makeTrade('timeout', 0)];
    const m = computeMetrics(trades);
    expect(m.profitFactor).toBe(Infinity);
  });

  it('returns 0 profitFactor when there is no positive R at all', () => {
    const trades = [makeTrade('loss', -1), makeTrade('timeout', 0)];
    const m = computeMetrics(trades);
    expect(m.profitFactor).toBe(0);
  });

  it('tracks maxDrawdownR as the largest peak-to-trough drop in cumulative R, in trade order', () => {
    // Cumulative R: 2, 1, 3, 0 -> peak 3 after trade 3, trough 0 after
    // trade 4 -> drawdown 3.
    const trades = [makeTrade('win', 2), makeTrade('loss', -1), makeTrade('win', 2), makeTrade('loss', -3)];
    const m = computeMetrics(trades);
    expect(m.maxDrawdownR).toBeCloseTo(3, 6);
  });

  it('counts maxConsecutiveLosses skipping over timeouts (timeout neither breaks nor extends a streak)', () => {
    const trades = [
      makeTrade('loss', -1),
      makeTrade('loss', -1),
      makeTrade('timeout', 0),
      makeTrade('loss', -1),
      makeTrade('win', 1),
    ];
    const m = computeMetrics(trades);
    expect(m.maxConsecutiveLosses).toBe(3);
  });
});

describe('computeSplitMetrics', () => {
  it('splits metrics by inSample flag and also reports the combined "all" bucket', () => {
    const trades = [
      makeTrade('win', 1, { inSample: true }),
      makeTrade('loss', -1, { inSample: true }),
      makeTrade('win', 3, { inSample: false }),
    ];
    const split = computeSplitMetrics(trades);
    expect(split.inSample.totalTrades).toBe(2);
    expect(split.outOfSample.totalTrades).toBe(1);
    expect(split.all.totalTrades).toBe(3);
    expect(split.outOfSample.averageWinR).toBeCloseTo(3, 6);
  });
});

describe('computeMetricsBySession', () => {
  it('groups trades into all six session buckets and preserves the total count', () => {
    const trades = [
      makeTrade('win', 1, { signal: { calibratedProbability: 0.6, time: 1_700_000_000 } as unknown as Signal }),
      makeTrade('loss', -1, { signal: { calibratedProbability: 0.6, time: 1_700_050_000 } as unknown as Signal }),
    ];
    const bySession = computeMetricsBySession(trades);
    const keys = Object.keys(bySession);
    expect(keys.sort()).toEqual(['closed', 'london', 'newyork', 'overlap', 'sydney', 'tokyo'].sort());
    const totalAcrossSessions = Object.values(bySession).reduce((sum, m) => sum + m.totalTrades, 0);
    expect(totalAcrossSessions).toBe(trades.length);
  });
});
