import type { Candle, IndicatorConfig, FeatureName, PatternResult, SignalDirection } from '@/types/domain';
import { ALL_FEATURES } from '@/types/domain';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import { binomialSignificanceTest, type SignificanceResult } from './significance';

// РЕФАКТОРИНГ (бинарные опционы, Фаза 2/4): реализует ровно ту процедуру,
// которую требует direction-horizon-source-variant-B.md (раздел 3) и
// pattern-audit-checklist.md ("Как заполнять пустые колонки") — для каждого
// из 42 паттернов и его стартовой сетки `expiryBars` (см. HYPOTHESES ниже,
// перенесены дословно из чек-листа):
//
//   1. Собрать ВСЕ исторические срабатывания паттерна (направление + бар),
//      независимо от продакшен-гейтов score/сессии/cooldown — вопрос
//      "предсказателен ли паттерн сам по себе на горизонте N" не совпадает
//      с вопросом "проходит ли он вдобавок все остальные фильтры пайплайна"
//      (последнее уже покрыто backtest/simulator.ts + report.ts).
//   2. Разбить события ХРОНОЛОГИЧЕСКИ на train/validation/test (60/20/20 —
//      не случайно, см. источник, п.1).
//   3. Выбрать лучший `expiryBars` из сетки по accuracy на train+validation.
//   4. Замерить accuracy этого `expiryBars` на отложенном test — только эта
//      цифра попадает в отчёт (не accuracy, на которой подбирался горизонт).
//   5. Прогнать тест значимости (см. significance.ts) на test-выборке против
//      случайного бейзлайна 0.5 — паттерн считается "подтверждённым
//      источником сигнала" только если тест пройден.
//
// Паттерн Doji/Spinning Top (checklist, строки 17/22) НЕ регистрируется в
// HYPOTHESES вообще — это не забытая работа, а продуктовое решение (см.
// DIRECTIONALLY_UNRELIABLE_PATTERNS в settingsStore.ts): у них нет
// направленной гипотезы, которую имеет смысл тестировать по этой методике.

export interface PatternEvent {
  /** Индекс бара (в переданном массиве candles), на котором паттерн сработал. */
  barIndex: number;
  direction: SignalDirection;
  entryPrice: number;
  /** Только для harmonic-pattern — длительность ноги AB в барах (Фаза 2, адаптивный горизонт). */
  harmonicAbLegBars?: number;
}

export interface PatternHorizonHypothesis {
  /** Соответствует № строки в pattern-audit-checklist.md. */
  row: string;
  /** Человекочитаемое имя для отчёта — совпадает с колонкой "Паттерн". */
  label: string;
  /** PatternResult.name, которое нужно искать среди результатов detectAllPatterns. */
  patternName: string;
  /** Для liquidity-sweep — какой setupType считать этой строкой (см. checklist, строки 13-14). */
  setupTypeFilter?: 'continuation' | 'reversal-at-key-level';
  /** Стартовая сетка expiryBars, ровно как в pattern-audit-checklist.md. */
  expiryBarsGrid: number[];
  /** harmonic-pattern (checklist, строка 4) — дополнительно проверяется expiryBars ≈ длительность AB-ноги. */
  useAdaptiveHarmonicHorizon?: boolean;
  /**
   * Минимальный индекс бара, на котором паттерн МОЖЕТ сработать логически
   * (methodological fix из checklist, строка 31: 3-свечные формации не
   * тестируются на expiryBars < 3, т.к. сами уже "потратили" 3 бара на
   * формирование). Отфильтровывает такие значения из грида здесь же, а не
   * полагается на то, что вызывающий код помнит об этом отдельно.
   */
  minExpiryBars?: number;
}

// Перенесено дословно из pattern-audit-checklist.md ("Таблица «Гипотеза
// горизонта» — все 42 детектора"). Строки 17 (Doji) и 22 (Spinning Top) —
// намеренно отсутствуют (см. комментарий выше).
export const PATTERN_HORIZON_HYPOTHESES: PatternHorizonHypothesis[] = [
  { row: '1', label: 'impulse-breakout', patternName: 'impulse-breakout', expiryBarsGrid: [1, 2, 3] },
  { row: '2', label: 'liquidity-sweep-reaction', patternName: 'liquidity-sweep-reaction', expiryBarsGrid: [1, 2, 3] },
  { row: '3', label: 'order-block-continuation', patternName: 'order-block-continuation', expiryBarsGrid: [5, 10, 20, 30] },
  { row: '4', label: 'harmonic-pattern (фиксированная сетка)', patternName: 'harmonic-pattern', expiryBarsGrid: [10, 20, 30] },
  { row: '4b', label: 'harmonic-pattern (адаптивный горизонт ≈ AB-нога)', patternName: 'harmonic-pattern', expiryBarsGrid: [], useAdaptiveHarmonicHorizon: true },
  { row: '5', label: 'strong-order-block-reaction', patternName: 'strong-order-block-reaction', expiryBarsGrid: [1, 2, 3, 5, 10, 20, 30] },
  { row: '6', label: 'macd-deceleration-continuation', patternName: 'macd-deceleration-continuation', expiryBarsGrid: [5, 10, 20, 30] },
  { row: '7', label: 'fvg-return', patternName: 'fvg-return', expiryBarsGrid: [1, 2, 3, 5, 10, 20, 30] },
  { row: '8', label: 'fvg-rejection', patternName: 'fvg-rejection', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '9', label: 'fvg-breaker-block', patternName: 'fvg-breaker-block', expiryBarsGrid: [5, 10, 20, 30] },
  { row: '10', label: 'fvg-nested', patternName: 'fvg-nested', expiryBarsGrid: [5, 10, 20, 30] },
  { row: '11', label: 'order-block-breaker', patternName: 'order-block-breaker', expiryBarsGrid: [5, 10, 20, 30] },
  { row: '12', label: 'order-block-nested', patternName: 'order-block-nested', expiryBarsGrid: [5, 10, 20, 30] },
  { row: '13', label: "liquidity-sweep (continuation)", patternName: 'liquidity-sweep', setupTypeFilter: 'continuation', expiryBarsGrid: [1, 2, 3] },
  { row: '14', label: 'liquidity-sweep (reversal-at-key-level)', patternName: 'liquidity-sweep', setupTypeFilter: 'reversal-at-key-level', expiryBarsGrid: [1, 2, 3] },
  { row: '15', label: 'Hammer', patternName: 'hammer', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '16', label: 'Shooting Star', patternName: 'shooting-star', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '18', label: 'Inverted Hammer', patternName: 'inverted-hammer', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '19', label: 'Hanging Man', patternName: 'hanging-man', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '20', label: 'Marubozu Bullish', patternName: 'marubozu-bullish', expiryBarsGrid: [1, 2, 3] },
  { row: '21', label: 'Marubozu Bearish', patternName: 'marubozu-bearish', expiryBarsGrid: [1, 2, 3] },
  { row: '23', label: 'Bullish Engulfing', patternName: 'bullish-engulfing', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '24', label: 'Bearish Engulfing', patternName: 'bearish-engulfing', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '25', label: 'Bullish Harami', patternName: 'bullish-harami', expiryBarsGrid: [2, 3, 5, 10] },
  { row: '26', label: 'Bearish Harami', patternName: 'bearish-harami', expiryBarsGrid: [2, 3, 5, 10] },
  { row: '27', label: 'Piercing Line', patternName: 'piercing-line', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '28', label: 'Dark Cloud Cover', patternName: 'dark-cloud-cover', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '29', label: 'Tweezer Bottom', patternName: 'tweezer-bottom', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '30', label: 'Tweezer Top', patternName: 'tweezer-top', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '31', label: 'Morning Star', patternName: 'morning-star', expiryBarsGrid: [3, 5, 10], minExpiryBars: 3 },
  { row: '32', label: 'Evening Star', patternName: 'evening-star', expiryBarsGrid: [3, 5, 10], minExpiryBars: 3 },
  { row: '33', label: 'Three White Soldiers', patternName: 'three-white-soldiers', expiryBarsGrid: [3, 5, 10], minExpiryBars: 3 },
  { row: '34', label: 'Three Black Crows', patternName: 'three-black-crows', expiryBarsGrid: [3, 5, 10], minExpiryBars: 3 },
  { row: '35', label: 'Abandoned Baby Bottom', patternName: 'abandoned-baby-bottom', expiryBarsGrid: [3, 5, 10], minExpiryBars: 3 },
  { row: '36', label: 'Abandoned Baby Top', patternName: 'abandoned-baby-top', expiryBarsGrid: [3, 5, 10], minExpiryBars: 3 },
  { row: '37', label: 'Pin Bar', patternName: 'pin-bar', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '38a', label: 'Rising Three Methods', patternName: 'rising-three-methods', expiryBarsGrid: [10, 20, 30] },
  { row: '38b', label: 'Falling Three Methods', patternName: 'falling-three-methods', expiryBarsGrid: [10, 20, 30] },
  { row: '39', label: 'Consolidation Breakout', patternName: 'consolidation-breakout', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '40', label: 'Inside Bar', patternName: 'inside-bar', expiryBarsGrid: [1, 2, 3, 5] },
  { row: '41', label: 'Mean Reversion', patternName: 'mean-reversion', expiryBarsGrid: [5, 10, 15, 20] },
];

export interface HorizonEvalResult {
  hypothesis: PatternHorizonHypothesis;
  totalEvents: number;
  /** null если событий недостаточно даже для train/val (нет с чем выбирать). */
  bestExpiryBars: number | 'adaptive-ab-leg' | null;
  trainValAccuracy: number | null;
  test: SignificanceResult | null;
  note?: string;
}

interface SplitEvents {
  train: PatternEvent[];
  validation: PatternEvent[];
  test: PatternEvent[];
}

// direction-horizon-source-variant-B.md, раздел 3, п.1: хронологический
// 60/20/20 split — НЕ случайный (случайный split на автокоррелированных
// финансовых рядах течёт информация из будущего в train через соседние по
// времени, коррелированные бары).
function splitChronologically(events: PatternEvent[]): SplitEvents {
  const sorted = [...events].sort((a, b) => a.barIndex - b.barIndex);
  const n = sorted.length;
  const trainEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  return {
    train: sorted.slice(0, trainEnd),
    validation: sorted.slice(trainEnd, valEnd),
    test: sorted.slice(valEnd),
  };
}

function directionalOutcome(event: PatternEvent, candles: Candle[], expiryBars: number): 'win' | 'loss' | 'tie' | null {
  const expiryIndex = event.barIndex + expiryBars;
  if (expiryIndex >= candles.length) return null;
  const expiryClose = candles[expiryIndex].close;
  if (expiryClose === event.entryPrice) return 'tie';
  const isLong = event.direction === 'buy';
  return (expiryClose > event.entryPrice) === isLong ? 'win' : 'loss';
}

function accuracyFor(events: PatternEvent[], candles: Candle[], expiryBars: number): { wins: number; decided: number } {
  let wins = 0;
  let decided = 0;
  for (const e of events) {
    const outcome = directionalOutcome(e, candles, expiryBars);
    if (outcome === null || outcome === 'tie') continue;
    decided += 1;
    if (outcome === 'win') wins += 1;
  }
  return { wins, decided };
}

/**
 * Собирает все исторические срабатывания каждого зарегистрированного
 * паттерна (см. PATTERN_HORIZON_HYPOTHESES) методом скользящего окна по
 * detectAllPatterns — независимо от продакшен-гейтов (см. заголовочный
 * комментарий файла, п.1).
 */
export function collectPatternEvents(
  candles: Candle[],
  config: IndicatorConfig,
): Map<string, PatternEvent[]> {
  const events = new Map<string, PatternEvent[]>();
  const key = (patternName: string, setupType?: string) => setupType ? `${patternName}:${setupType}` : patternName;

  const warmup = Math.max(config.emaSlow, config.bbPeriod, config.macdSlow, config.rsiPeriod, config.atrPeriod) + 5;
  const activeFeatures: FeatureName[] = [...ALL_FEATURES];

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const { snapshot } = buildFullSnapshot(window, config, activeFeatures);
    const results: PatternResult[] = snapshot.patterns;

    for (const p of results) {
      const k = key(p.name, p.setupType);
      const arr = events.get(k) ?? [];
      arr.push({
        barIndex: i,
        direction: p.direction,
        entryPrice: candles[i].close,
        harmonicAbLegBars: p.harmonicAbLegBars,
      });
      events.set(k, arr);
    }
  }

  return events;
}

/**
 * Реализует всю процедуру из заголовочного комментария файла для ОДНОЙ
 * гипотезы (одной строки чек-листа).
 */
export function evaluateHorizonHypothesis(
  hypothesis: PatternHorizonHypothesis,
  allEvents: Map<string, PatternEvent[]>,
  candles: Candle[],
): HorizonEvalResult {
  const key = hypothesis.setupTypeFilter ? `${hypothesis.patternName}:${hypothesis.setupTypeFilter}` : hypothesis.patternName;
  const events = allEvents.get(key) ?? [];

  if (events.length === 0) {
    return { hypothesis, totalEvents: 0, bestExpiryBars: null, trainValAccuracy: null, test: null, note: 'нет исторических срабатываний паттерна в переданной выборке' };
  }

  const { train, validation, test } = splitChronologically(events);
  const trainVal = [...train, ...validation];

  if (hypothesis.useAdaptiveHarmonicHorizon) {
    // Фаза 2 (гипотеза временно́й симметрии, checklist строка 4b): здесь
    // "expiryBars" не фиксированное число, а per-signal — длительность
    // AB-ноги этого конкретного сигнала. Оцениваем сразу на всей выборке
    // train+val для отчёта о применимости, финальная accuracy — на test.
    const evalAdaptive = (evs: PatternEvent[]) => {
      let wins = 0;
      let decided = 0;
      for (const e of evs) {
        if (e.harmonicAbLegBars === undefined) continue;
        const outcome = directionalOutcome(e, candles, e.harmonicAbLegBars);
        if (outcome === null || outcome === 'tie') continue;
        decided += 1;
        if (outcome === 'win') wins += 1;
      }
      return { wins, decided };
    };
    const trainValResult = evalAdaptive(trainVal);
    const testResult = evalAdaptive(test);
    return {
      hypothesis,
      totalEvents: events.length,
      bestExpiryBars: 'adaptive-ab-leg',
      trainValAccuracy: trainValResult.decided > 0 ? trainValResult.wins / trainValResult.decided : null,
      test: binomialSignificanceTest(testResult.wins, testResult.decided),
    };
  }

  const grid = hypothesis.expiryBarsGrid.filter((b) => b >= (hypothesis.minExpiryBars ?? 1));
  let bestBars: number | null = null;
  let bestAccuracy = -1;
  for (const bars of grid) {
    const { wins, decided } = accuracyFor(trainVal, candles, bars);
    if (decided === 0) continue;
    const acc = wins / decided;
    if (acc > bestAccuracy) {
      bestAccuracy = acc;
      bestBars = bars;
    }
  }

  if (bestBars === null) {
    return { hypothesis, totalEvents: events.length, bestExpiryBars: null, trainValAccuracy: null, test: null, note: 'ни одно значение expiryBars из сетки не дало ни одного решённого исхода на train+val (недостаточно будущих баров в выборке)' };
  }

  const testResult = accuracyFor(test, candles, bestBars);
  return {
    hypothesis,
    totalEvents: events.length,
    bestExpiryBars: bestBars,
    trainValAccuracy: bestAccuracy,
    test: binomialSignificanceTest(testResult.wins, testResult.decided),
  };
}

export function runPatternHorizonGrid(candles: Candle[], config: IndicatorConfig): HorizonEvalResult[] {
  const allEvents = collectPatternEvents(candles, config);
  return PATTERN_HORIZON_HYPOTHESES.map((h) => evaluateHorizonHypothesis(h, allEvents, candles));
}

export function formatHorizonReportMarkdown(results: HorizonEvalResult[]): string {
  const lines: string[] = [];
  lines.push('| № | Паттерн | Событий | Лучший expiryBars (train+val) | Accuracy (train+val) | Accuracy (test) | Значим против случайного? | Примечание |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const bars = r.bestExpiryBars === null ? '—' : r.bestExpiryBars === 'adaptive-ab-leg' ? 'адаптивно (≈AB-нога)' : String(r.bestExpiryBars);
    const trainAcc = r.trainValAccuracy !== null ? `${(r.trainValAccuracy * 100).toFixed(1)}%` : '—';
    let testAcc = '—';
    let verdict = '—';
    if (r.test) {
      if (r.test.reason === 'insufficient-samples') {
        testAcc = `${(r.test.observedAccuracy * 100).toFixed(1)}% (n=${r.test.total})`;
        verdict = 'недостаточно данных';
      } else {
        testAcc = `${(r.test.observedAccuracy * 100).toFixed(1)}% (n=${r.test.total})`;
        verdict = r.test.significant ? `да (p=${r.test.pValue.toExponential(2)})` : `нет (p=${r.test.pValue.toFixed(3)})`;
      }
    }
    lines.push(`| ${r.hypothesis.row} | ${r.hypothesis.label} | ${r.totalEvents} | ${bars} | ${trainAcc} | ${testAcc} | ${verdict} | ${r.note ?? ''} |`);
  }
  return lines.join('\n');
}
