import type { PatternName } from '@/types/domain';
import {
  wilsonLowerBound,
  suggestedMultiplierFromWinRate,
  breakevenWinRateFromProfitPercent,
} from '@/lib/pattern-reliability-calibration';
import { PATTERN_LABELS_RU } from '@/lib/pattern-categories';
import type { HorizonEvalResult } from './pattern-horizon';
import { MIN_SAMPLES_FOR_SIGNIFICANCE, binomialSignificanceTest } from './significance';

// РЕФАКТОРИНГ (бинарные опционы, Фаза 2 п.4/п.6, Фаза 4): промт требует
// дословно — "паттерны, прошедшие тест значимости, получают вес,
// коррелирующий с accuracy; паттерны, НЕ прошедшие тест, получают вес 0
// (не пониженный, а именно исключающий из пула генерации сигналов),
// независимо от точечной оценки accuracy на любом отдельном expiryBars".
// Этот модуль — единственное место, которое переводит "тройку" результата
// backtest/pattern-horizon.ts (лучший expiryBars, accuracy на test, прошёл
// ли тест значимости) в конкретное число для PATTERN_RELIABILITY_MULTIPLIER
// (см. src/lib/pattern-categories.ts) — тот же множитель, что уже
// применяется в scoring (direction-prediction.ts::getReliabilityMultiplier).
//
// ВАЖНО: НЕ вызывается автоматически ни при сборке, ни в тестах — только
// явно, из отдельного CLI-скрипта, ПОСЛЕ прогона на реальных исторических
// данных (см. REFACTOR_STATUS.md, "Отложено на завершающий этап
// рефакторинга"). Юнит-тесты этого файла проверяют только правильность
// САМОЙ формулы конвертации на синтетических числах — не подставляют
// результат в PATTERN_RELIABILITY_MULTIPLIER автоматически ни в одном
// тесте, чтобы синтетика никогда не могла случайно попасть в дефолты
// продакшен-скоринга.

export type PatternWeightDecision =
  | { kind: 'excluded'; reason: string }
  | { kind: 'weighted'; multiplier: number; pooledAccuracy: number; pooledSamples: number }
  | { kind: 'unchanged'; reason: string };

export interface PatternWeightRow {
  patternName: PatternName;
  label: string;
  /** Строки чек-листа (hypothesis.row), объединённые в это решение — напр. ['13','14'] для liquidity-sweep. */
  sourceRows: string[];
  decision: PatternWeightDecision;
}

/**
 * Объединяет несколько строк чек-листа, ссылающихся на ОДНО и то же
 * PatternName (напр. liquidity-sweep: continuation + reversal-at-key-level;
 * harmonic-pattern: фиксированная сетка + адаптивный AB-горизонт), в одно
 * статистически корректное решение — пулинг wins/decided через ОДИН общий
 * тест значимости, а не выбор "какая строка лучше выглядит". Строки с
 * insufficient-samples по отдельности всё равно пулятся вместе с
 * остальными — это единственный шанс для редких паттернов (напр.
 * liquidity-sweep reversal-at-key-level) набрать достаточную выборку.
 */
function poolSameName(results: HorizonEvalResult[]): { wins: number; decided: number; rows: string[] } {
  let wins = 0;
  let decided = 0;
  const rows: string[] = [];
  for (const r of results) {
    if (!r.test) continue;
    rows.push(r.hypothesis.row);
    // SignificanceResult не хранит wins отдельно от observedAccuracy для
    // insufficient-samples (pValue=NaN, но wins/total всегда заполнены) —
    // безопасно суммировать в обоих случаях.
    wins += r.test.wins;
    decided += r.test.total;
  }
  return { wins, decided, rows };
}

const PROFIT_PERCENT_ASSUMPTION_NOTE =
  'Множитель посчитан от предполагаемой выплаты 80% (DEFAULT_PROFIT_PERCENT_FALLBACK) — ' +
  'при реальном прогоне передавать фактический profitPercent символа/счёта.';

/**
 * Основная функция Фазы 2 п.4/п.6: превращает результаты
 * backtest/pattern-horizon.ts в решения по весу для КАЖДОГО уникального
 * PatternName (после пулинга строк с одинаковым именем).
 */
export function computePatternWeightDecisions(
  results: HorizonEvalResult[],
  profitPercent: number = 80,
): PatternWeightRow[] {
  const breakeven = breakevenWinRateFromProfitPercent(profitPercent);
  const byPatternName = new Map<PatternName, HorizonEvalResult[]>();
  for (const r of results) {
    const name = r.hypothesis.patternName as PatternName;
    const arr = byPatternName.get(name) ?? [];
    arr.push(r);
    byPatternName.set(name, arr);
  }

  const rows: PatternWeightRow[] = [];
  for (const [patternName, group] of byPatternName) {
    const label = PATTERN_LABELS_RU[patternName] ?? patternName;
    const pooled = poolSameName(group);

    if (pooled.decided === 0) {
      rows.push({
        patternName, label, sourceRows: group.map((g) => g.hypothesis.row),
        decision: { kind: 'unchanged', reason: 'Нет ни одного решённого исхода ни по одной гипотезе горизонта для этого паттерна — недостаточно данных для любого решения.' },
      });
      continue;
    }

    const pooledTest = binomialSignificanceTest(pooled.wins, pooled.decided, 0.5);

    if (pooledTest.reason === 'insufficient-samples') {
      rows.push({
        patternName, label, sourceRows: pooled.rows,
        decision: { kind: 'unchanged', reason: `Недостаточно данных даже после объединения гипотез горизонта (n=${pooled.decided} < ${MIN_SAMPLES_FOR_SIGNIFICANCE}) — вес не меняется.` },
      });
      continue;
    }

    if (!pooledTest.significant) {
      rows.push({
        patternName, label, sourceRows: pooled.rows,
        decision: { kind: 'excluded', reason: `Не прошёл тест значимости против случайного направления даже на объединённой выборке (accuracy=${(pooledTest.observedAccuracy * 100).toFixed(1)}%, n=${pooled.decided}, p=${pooledTest.pValue.toFixed(3)}) — исключён из пула генерации сигналов (вес 0), а не понижен.` },
      });
      continue;
    }

    // Значим: множитель — та же формула, что уже применяется в live
    // self-learning (pattern-reliability-calibration.ts), для
    // согласованности "backtest-дефолт" и "live-коррекция поверх него" —
    // нижняя граница Уилсона (консервативнее сырого accuracy), делённая на
    // безубыток при данной выплате.
    const reliableAccuracy = wilsonLowerBound(pooled.wins, pooled.decided);
    const multiplier = Math.round(suggestedMultiplierFromWinRate(reliableAccuracy, breakeven) * 100) / 100;
    rows.push({
      patternName, label, sourceRows: pooled.rows,
      decision: { kind: 'weighted', multiplier, pooledAccuracy: pooledTest.observedAccuracy, pooledSamples: pooled.decided },
    });
  }

  return rows.sort((a, b) => a.patternName.localeCompare(b.patternName));
}

/** Готовый объект для applyReliabilityMultiplierUpdatesForSymbol / прямой правки PATTERN_RELIABILITY_MULTIPLIER defaults. Строки 'unchanged' сознательно опущены — не перезаписывать то, что мы не знаем. */
export function toPatternWeightUpdates(rows: PatternWeightRow[]): Partial<Record<PatternName, number>> {
  const updates: Partial<Record<PatternName, number>> = {};
  for (const row of rows) {
    if (row.decision.kind === 'weighted') updates[row.patternName] = row.decision.multiplier;
    else if (row.decision.kind === 'excluded') updates[row.patternName] = 0;
  }
  return updates;
}

export function formatPatternWeightReportMarkdown(rows: PatternWeightRow[]): string {
  const lines: string[] = [];
  lines.push(`_${PROFIT_PERCENT_ASSUMPTION_NOTE}_`);
  lines.push('');
  lines.push('| Паттерн | Строки чек-листа | Решение | Множитель/вес | Обоснование |');
  lines.push('|---|---|---|---|---|');
  for (const row of rows) {
    const rowsStr = row.sourceRows.join(', ');
    const kindLabel = row.decision.kind === 'weighted' ? 'вес по accuracy' : row.decision.kind === 'excluded' ? 'ИСКЛЮЧЁН (вес 0)' : 'без изменений';
    const value = row.decision.kind === 'weighted' ? row.decision.multiplier.toFixed(2) : row.decision.kind === 'excluded' ? '0' : '—';
    const reason = row.decision.kind === 'weighted'
      ? `accuracy=${(row.decision.pooledAccuracy * 100).toFixed(1)}%, n=${row.decision.pooledSamples}`
      : row.decision.reason;
    lines.push(`| ${row.label} | ${rowsStr} | ${kindLabel} | ${value} | ${reason} |`);
  }
  return lines.join('\n');
}
