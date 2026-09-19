import { describe, it, expect } from 'vitest';
import { resample } from './resampler';
import { computeMetrics } from './metrics';
import type { SimulatedTrade } from './simulator';
import type { Candle, Signal } from '@/types/domain';

function makeCandle(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 100 };
}

function makeSignal(time: number, prob: number): Signal {
  return {
    id: `test:${time}`,
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: prob,
    entryPrice: 100,
    stopLoss: 90,
    takeProfit: 110,
    reason: 'test',
    indicators: {
      rsi: 50,
      emaFast: 100,
      emaSlow: 99,
      macd: 0.5,
      macdSignal: 0.3,
      macdHistogram: 0.2,
      atr: 2,
      bollingerUpper: 105,
      bollingerMiddle: 100,
      bollingerLower: 95,
      vwap: 100,
      vwapIsProxyVolume: false,
      volumeProfilePoc: 100,
      volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null,
      impulseVelocity: null,
      adx: null,
    },
    pattern: null,
    time,
    timeframe: '15m',
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 900,
    featureVector: [0.5, 0.01, 0.2, 0.1, 2, 100, 0, 1, 0, 1, 0, 0],
    factors: [],
    rejectedPatterns: [],
    engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
  };
}

// Refactor variant A, Фаза 5: rMultiple теперь обязательное поле
// SimulatedTrade — реальная доходность сделки в единицах риска, а не
// выводимая на лету из внешнего profitPercent. rMultipleOverride
// необязателен: дефолт 0.8/-1/0 по outcome воспроизводит ту же числовую
// модель, что раньше подразумевал захардкоженный payout=80% в вызовах
// computeMetrics(trades, 80) ниже — большинство существующих сценариев
// не должны были поменять свои ожидаемые числа.
function makeTrade(
  time: number,
  prob: number,
  outcome: 'win' | 'loss' | 'timeout',
  rMultipleOverride?: number,
): SimulatedTrade {
  const defaultR = outcome === 'win' ? 0.8 : outcome === 'loss' ? -1 : 0;
  return {
    signal: makeSignal(time, prob),
    outcome,
    entryTime: time,
    candleIndex: 0,
    spreadCostR: 0,
    rMultiple: rMultipleOverride ?? defaultR,
    inSample: true,
  };
}

describe('resampler', () => {
  it('returns 1m candles unchanged', () => {
    const candles = [makeCandle(0, 100), makeCandle(60, 101), makeCandle(120, 102)];
    const result = resample(candles, '1m');
    expect(result).toHaveLength(3);
    expect(result[0].close).toBe(100);
  });

  it('resamples 1m to 5m correctly', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        time: i * 60,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 10,
      });
    }
    const result = resample(candles, '5m');
    expect(result).toHaveLength(2);
    expect(result[0].time).toBe(0);
    expect(result[0].open).toBe(100);
    expect(result[0].high).toBe(105);
    expect(result[0].low).toBe(99);
    expect(result[0].close).toBe(104);
    expect(result[0].volume).toBe(50);
  });

  it('handles partial bucket at end', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 7; i++) {
      candles.push({ time: i * 60, open: 100, high: 101, low: 99, close: 100, volume: 10 });
    }
    const result = resample(candles, '5m');
    expect(result).toHaveLength(2);
    expect(result[1].volume).toBe(20);
  });
});

describe('metrics', () => {
  it('handles zero trades', () => {
    const m = computeMetrics([]);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.brierScore).toBe(0);
  });

  it('computes win rate correctly (excludes timeouts from the denominator)', () => {
    const trades = [
      makeTrade(0, 0.6, 'win'),
      makeTrade(60, 0.6, 'loss'),
      makeTrade(120, 0.6, 'win'),
      makeTrade(180, 0.6, 'timeout'),
    ];
    const m = computeMetrics(trades);
    expect(m.totalTrades).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.timeouts).toBe(1);
    // BUGFIX (аудит 2026-09-13): раньше было wins/total = 2/4 = 0.5 —
    // единственное место в проекте, включавшее timeout в знаменатель
    // винрейта. Теперь как везде (useAnalyticsStore, forward-test
    // вердикт): wins/(wins+losses) = 2/3, timeout — не выигрыш и не
    // проигрыш, ставка просто возвращается.
    expect(m.winRate).toBeCloseTo(2 / 3, 5);
  });

  // Refactor variant A, Фаза 5 — заменяет прежний тест "computes average
  // return using the configured payout": глобального payout-параметра
  // больше нет, averageR считается напрямую от SimulatedTrade.rMultiple
  // каждой сделки (та же формула позиционного P&L, что и на демо-счёте,
  // см. simulator.ts) — здесь пример с тем же payout=80%, что и раньше
  // (rMultiple=0.8 для win), выраженным уже как реальная доходность
  // сделки, а не как внешний параметр функции.
  it('computes average return from each trade\'s own rMultiple, not a fixed 2:1 model', () => {
    const trades = [makeTrade(0, 0.6, 'win', 0.8), makeTrade(60, 0.6, 'loss')];
    const m = computeMetrics(trades);
    // (0.8 + (-1)) / 2 = -0.1
    expect(m.averageR).toBeCloseTo(-0.1, 5);
  });

  // Refactor variant A, Фаза 5 — заменяет прежний тест "a higher payout
  // increases average return": тот тест проверял чувствительность к
  // ВНЕШНЕМУ параметру функции, которого больше не существует (payout
  // определялся не сделкой, а конфигурацией счёта). Тот же содержательный
  // эффект ("больше доходность на победе -> выше средний R") теперь
  // проверяется через саму сделку — её rMultiple.
  it('a trade with a larger realized win rMultiple increases average return for the same win/loss sequence', () => {
    const at80 = computeMetrics([makeTrade(0, 0.6, 'win', 0.8), makeTrade(60, 0.6, 'loss')]);
    const at100 = computeMetrics([makeTrade(0, 0.6, 'win', 1.0), makeTrade(60, 0.6, 'loss')]);
    expect(at100.averageR).toBeGreaterThan(at80.averageR);
    expect(at100.averageR).toBeCloseTo(0, 5); // (1 + (-1)) / 2 = 0
  });

  // Refactor variant A, Фаза 5 — averageWinR (metrics.ts): средний R
  // ТОЛЬКО среди побед, независимо от losses/timeouts в той же выборке;
  // это и есть единственный содержательный вход для точки безубыточности
  // форвард-теста (см. change-registry.ts::breakevenWinRateFromAverageWinR).
  it('computes averageWinR from wins only, ignoring losses and timeouts', () => {
    const trades = [
      makeTrade(0, 0.6, 'win', 0.5),
      makeTrade(60, 0.6, 'win', 1.5),
      makeTrade(120, 0.6, 'loss'),
      makeTrade(180, 0.6, 'timeout'),
    ];
    const m = computeMetrics(trades);
    expect(m.averageWinR).toBeCloseTo(1.0, 5);
  });

  it('computes Brier score', () => {
    const trades = [
      makeTrade(0, 0.8, 'win'),
      makeTrade(60, 0.3, 'loss'),
    ];
    const m = computeMetrics(trades);
    expect(m.brierScore).toBeCloseTo(0.065, 5);
  });

  it('computes max drawdown', () => {
    const trades = [
      makeTrade(0, 0.6, 'win'),
      makeTrade(60, 0.6, 'loss'),
      makeTrade(120, 0.6, 'loss'),
      makeTrade(180, 0.6, 'win'),
    ];
    const m = computeMetrics(trades);
    // Два подряд убытка (-1 каждый) от пика 0.8 дают просадку 2.0 — не
    // зависит от payout в этом конкретном сценарии, так как максимум
    // просадки достигается ДО следующего выигрыша.
    expect(m.maxDrawdownR).toBe(2);
  });

  it('computes profit factor from each trade\'s own rMultiple', () => {
    const trades = [
      makeTrade(0, 0.6, 'win'),
      makeTrade(60, 0.6, 'win'),
      makeTrade(120, 0.6, 'loss'),
    ];
    const m = computeMetrics(trades);
    // grossProfit = 0.8 + 0.8 = 1.6, grossLoss = 1 -> 1.6
    expect(m.profitFactor).toBeCloseTo(1.6, 5);
  });

  it('builds reliability bins', () => {
    const trades = [
      makeTrade(0, 0.05, 'loss'),
      makeTrade(60, 0.15, 'loss'),
      makeTrade(120, 0.85, 'win'),
      makeTrade(180, 0.95, 'win'),
    ];
    const m = computeMetrics(trades);
    expect(m.reliabilityBins).toHaveLength(10);
    expect(m.reliabilityBins[0].count).toBe(1);
    expect(m.reliabilityBins[0].avgActual).toBe(0);
    expect(m.reliabilityBins[9].count).toBe(1);
    expect(m.reliabilityBins[9].avgActual).toBe(1);
  });

  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): до этой
  // правки в бэктесте не было вообще никакой метрики серийности —
  // winRate/profitFactor усредняют по выборке и не видят порядок сделок.
  describe('maxConsecutiveLosses', () => {
    it('is 0 when there are no trades', () => {
      expect(computeMetrics([]).maxConsecutiveLosses).toBe(0);
    });

    it('is 0 when there are no losses at all', () => {
      const trades = [makeTrade(0, 0.6, 'win'), makeTrade(60, 0.6, 'win')];
      expect(computeMetrics(trades).maxConsecutiveLosses).toBe(0);
    });

    it('counts a run of consecutive losses, reusing the same "computes max drawdown" fixture above', () => {
      const trades = [
        makeTrade(0, 0.6, 'win'),
        makeTrade(60, 0.6, 'loss'),
        makeTrade(120, 0.6, 'loss'),
        makeTrade(180, 0.6, 'win'),
      ];
      expect(computeMetrics(trades).maxConsecutiveLosses).toBe(2);
    });

    it('finds the longest streak, not just the most recent one', () => {
      const trades = [
        makeTrade(0, 0.6, 'loss'),
        makeTrade(60, 0.6, 'loss'),
        makeTrade(120, 0.6, 'loss'),
        makeTrade(180, 0.6, 'win'),
        makeTrade(240, 0.6, 'loss'),
        makeTrade(300, 0.6, 'win'),
      ];
      expect(computeMetrics(trades).maxConsecutiveLosses).toBe(3);
    });

    it('a timeout in the middle of a losing run neither extends nor breaks the streak', () => {
      const trades = [
        makeTrade(0, 0.6, 'loss'),
        makeTrade(60, 0.6, 'timeout'),
        makeTrade(120, 0.6, 'loss'),
      ];
      // The timeout is skipped entirely (same convention as winRate's
      // decided-only denominator above) — the two real losses on either
      // side of it still count as one continuous streak of 2, not two
      // separate streaks of 1.
      expect(computeMetrics(trades).maxConsecutiveLosses).toBe(2);
    });

    it('a win resets the streak even when it is immediately followed by more losses', () => {
      const trades = [
        makeTrade(0, 0.6, 'loss'),
        makeTrade(60, 0.6, 'loss'),
        makeTrade(120, 0.6, 'win'),
        makeTrade(180, 0.6, 'loss'),
      ];
      expect(computeMetrics(trades).maxConsecutiveLosses).toBe(2);
    });
  });
});
