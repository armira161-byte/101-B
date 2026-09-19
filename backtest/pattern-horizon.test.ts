import { describe, it, expect } from 'vitest';
import type { Candle, IndicatorConfig } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG } from '@/types/domain';
import {
  PATTERN_HORIZON_HYPOTHESES,
  collectPatternEvents,
  evaluateHorizonHypothesis,
  runPatternHorizonGrid,
  formatHorizonReportMarkdown,
} from './pattern-horizon';

// РЕФАКТОРИНГ (бинарные опционы, Фаза 2/4): это СМОУК-тест на синтетике —
// подтверждает, что харнесс запускается end-to-end, не падает и возвращает
// структурно корректный результат по всем 40 гипотезам чек-листа. Он
// НАМЕРЕННО не проверяет реальные числа accuracy — синтетический
// генератор ниже не воспроизводит реальную рыночную микроструктуру, и
// "хорошая" или "плохая" accuracy на нём не говорит ничего о реальных
// паттернах. Настоящие цифры для pattern-audit-checklist.md может дать
// только прогон на реальных исторических данных (см. отдельную
// рекомендацию по backtest/data-loader.ts — вне этой тестовой песочницы).

function makeCandle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1000 };
}

// Детерминированный псевдослучайный генератор (mulberry32) — не Math.random(),
// чтобы тест был воспроизводим и не флапал между запусками.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticCandles(n: number, seed = 42): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let price = 100;
  const startTime = 1700000000;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.48) * 0.6; // slight upward bias, plenty of noise
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rand() * 0.4;
    const low = Math.min(open, close) - rand() * 0.4;
    candles.push(makeCandle(startTime + i * 60, open, high, low, close));
    price = close;
  }
  return candles;
}

const CONFIG: IndicatorConfig = { ...DEFAULT_INDICATOR_CONFIG };

describe('collectPatternEvents (smoke)', () => {
  it('runs end-to-end over a synthetic series without throwing and returns a Map', () => {
    const candles = syntheticCandles(300);
    expect(() => collectPatternEvents(candles, CONFIG)).not.toThrow();
    const events = collectPatternEvents(candles, CONFIG);
    expect(events).toBeInstanceOf(Map);
  });

  it('every collected event has a valid barIndex within range and a buy/sell direction', () => {
    const candles = syntheticCandles(300);
    const events = collectPatternEvents(candles, CONFIG);
    for (const [, list] of events) {
      for (const e of list) {
        expect(e.barIndex).toBeGreaterThanOrEqual(0);
        expect(e.barIndex).toBeLessThan(candles.length);
        expect(['buy', 'sell']).toContain(e.direction);
      }
    }
  });
}, 30000);

describe('evaluateHorizonHypothesis (smoke)', () => {
  it('returns a well-formed "no data" result when a pattern never fires', () => {
    const empty = new Map();
    const hypothesis = PATTERN_HORIZON_HYPOTHESES.find((h) => h.row === '1')!;
    const result = evaluateHorizonHypothesis(hypothesis, empty, syntheticCandles(50));
    expect(result.totalEvents).toBe(0);
    expect(result.bestExpiryBars).toBeNull();
    expect(result.test).toBeNull();
    expect(result.note).toBeTruthy();
  });

  it('handles the adaptive AB-leg harmonic hypothesis without throwing, even with no events', () => {
    const empty = new Map();
    const hypothesis = PATTERN_HORIZON_HYPOTHESES.find((h) => h.row === '4b')!;
    expect(hypothesis.useAdaptiveHarmonicHorizon).toBe(true);
    const result = evaluateHorizonHypothesis(hypothesis, empty, syntheticCandles(50));
    expect(result.bestExpiryBars).toBeNull(); // no events at all -> short-circuits before adaptive branch
  });
});

describe('runPatternHorizonGrid (smoke)', () => {
  it('returns exactly one result per registered hypothesis, all well-formed', () => {
    const candles = syntheticCandles(300);
    const results = runPatternHorizonGrid(candles, CONFIG);
    expect(results).toHaveLength(PATTERN_HORIZON_HYPOTHESES.length);
    for (const r of results) {
      expect(r.totalEvents).toBeGreaterThanOrEqual(0);
      if (r.bestExpiryBars !== null && r.bestExpiryBars !== 'adaptive-ab-leg') {
        expect(r.bestExpiryBars).toBeGreaterThan(0);
      }
      if (r.test) {
        expect(r.test.observedAccuracy).toBeGreaterThanOrEqual(0);
        expect(r.test.observedAccuracy).toBeLessThanOrEqual(1);
        expect(['insufficient-samples', 'not-significant', 'significant']).toContain(r.test.reason);
      }
    }
  }, 30000);

  it('never registers doji or spinning-top (product decision — see settingsStore.ts DIRECTIONALLY_UNRELIABLE_PATTERNS)', () => {
    const names = PATTERN_HORIZON_HYPOTHESES.map((h) => h.patternName);
    expect(names).not.toContain('doji');
    expect(names).not.toContain('spinning-top');
  });

  it('splits liquidity-sweep into continuation and reversal-at-key-level as two independent rows', () => {
    const continuation = PATTERN_HORIZON_HYPOTHESES.find((h) => h.row === '13')!;
    const reversal = PATTERN_HORIZON_HYPOTHESES.find((h) => h.row === '14')!;
    expect(continuation.setupTypeFilter).toBe('continuation');
    expect(reversal.setupTypeFilter).toBe('reversal-at-key-level');
  });

  it('produces a markdown report with a row for every hypothesis and no thrown errors', () => {
    const candles = syntheticCandles(300);
    const results = runPatternHorizonGrid(candles, CONFIG);
    const markdown = formatHorizonReportMarkdown(results);
    expect(markdown).toContain('| № | Паттерн |');
    for (const h of PATTERN_HORIZON_HYPOTHESES) {
      expect(markdown).toContain(`| ${h.row} |`);
    }
  }, 30000);
});
