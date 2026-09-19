import { describe, it, expect } from 'vitest';
import type { Signal } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG, DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';
import { buildPostMortemReport } from './trade-report';

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'BTCUSDT:15m:100',
    symbolId: 'BTCUSDT',
    direction: 'sell',
    strength: 'strong',
    score: 3.4,
    calibratedProbability: 0.61,
    entryPrice: 1.16251,
    // BUGFIX (попутно обнаружено при аудите): для direction:'sell' стоп
    // должен быть ВЫШЕ входа, тейк — НИЖЕ (наоборот, чем для buy). Значения
    // ниже были вставлены как для buy и перепутаны местами.
    stopLoss: 1.179948,
    takeProfit: 1.150885,
    reason: 'CHoCH bearish; FVG Rejection strategy (+0.28); RSI overbought 68.4',
    indicators: {
      rsi: 68.4, emaFast: 1.1624, emaSlow: 1.1619, macd: 0, macdSignal: 0, macdHistogram: -0.00003,
      atr: 0.00021, bollingerUpper: 1.1631, bollingerMiddle: 1.1625, bollingerLower: 1.1618,
      vwap: 1.16255, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null, adx: 22.1,
    },
    pattern: null,
    time: 1000,
    timeframe: '5m',
    outcome: 'loss',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 1,
    spread: 0.00006,
    spreadSource: 'estimated',
    recommendedExpiry: 900,
    featureVector: [],
    factors: [
      { kind: 'structure', name: 'choch', direction: 'sell', contribution: -0.5, argument: 'CHoCH bearish' },
      { kind: 'strategy', name: 'fvg-rejection', direction: 'sell', contribution: 0.28, argument: 'FVG Rejection strategy' },
    ],
    rejectedPatterns: [
      { name: 'bullish-engulfing', direction: 'buy', confidence: 0.61, reasonNotSelected: 'lower-class-priority' },
    ],
    engineConfigSnapshot: {
      indicatorConfig: DEFAULT_INDICATOR_CONFIG,
      signalToggles: DEFAULT_SIGNAL_TOGGLES,
      activeFeatures: ['rsi', 'ema'],
      atrMultiplier: 1.5,
    },
    chartContext: {
      candlesBefore: [{ time: 940, open: 1.1626, high: 1.1627, low: 1.1624, close: 1.16251, volume: 10 }],
      candlesAfter: [{ time: 1060, open: 1.16251, high: 1.16295, low: 1.16240, close: 1.16289, volume: 10 }],
      maxFavorableExcursion: 0.00012,
      maxAdverseExcursion: 0.00041,
    },
    marketContext: {
      regime: 'trend',
      structure: { trend: 'up', bos: false, choch: true, swingHigh: null, swingLow: null, provisional: false },
      session: 'overlap',
    },
    ...overrides,
  };
}

describe('buildPostMortemReport', () => {
  // Refactor variant A, Фаза 5 (попутно обнаружено и исправлено): раньше
  // этот тест фиксировал СТАРУЮ бинарно-опционную модель ("резолвится по
  // цене закрытия через N баров, без SL/TP") — ровно то, что Фаза 0'/1
  // варианта А заменила на резолв по реальному касанию stopLoss/takeProfit
  // (см. resolve-by-levels.ts), плюс проверял поля (expiryBars/
  // estimatedPatternMaturityBars), которых в Signal больше нет.
  it('includes real SL/TP levels and the resolve horizon in the "Вход" line', () => {
    const report = buildPostMortemReport(makeSignal());
    const entryLine = report.split('\n').find((l) => l.startsWith('**Вход:**'));
    expect(entryLine).toBeDefined();
    expect(entryLine).toContain('SL ');
    expect(entryLine).toContain('TP ');
    expect(entryLine).toContain('горизонт резолва 1 бар(ов)');
    expect(entryLine).toContain('оценка зрелости сетапа 900 бар(ов)');
  });

  it('still renders factors, rejected patterns, engine config and excursion sections', () => {
    const report = buildPostMortemReport(makeSignal());
    expect(report).toContain('**Факторы, повлиявшие на сигнал:**');
    expect(report).toContain('CHoCH bearish');
    expect(report).toContain('**Отклонённые сигналы на этой же свече:**');
    expect(report).toContain('bullish-engulfing');
    expect(report).toContain('**Конфигурация движка на момент сигнала:**');
    expect(report).toContain('**Excursion:**');
  });

  it('does not throw for a pre-attribution signal with empty factors/rejectedPatterns', () => {
    const signal = makeSignal({ factors: [], rejectedPatterns: [] });
    expect(() => buildPostMortemReport(signal)).not.toThrow();
    const report = buildPostMortemReport(signal);
    expect(report).toContain('нет данных');
  });
});
