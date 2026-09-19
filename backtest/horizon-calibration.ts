#!/usr/bin/env tsx
//
// Refactor variant A, Фаза 5 — калибровочная сетка горизонта резолва по
// каждому паттерну отдельно.
//
// decision/pattern-horizon.ts проставляет maxHorizonBarsForPattern() из
// ГИПОТЕЗЫ ("вероятно короткие/средние/длинные", колонка в
// pattern-audit-checklist.md), а не из измеренного оптимума — сам файл
// прямо говорит: "финальные числа проставляются по результатам
// бэктест-сетки Фазы 5 (maxHorizonBars ∈ {5,10,20,30,50} отдельно по
// каждому паттерну)". Этот скрипт — та самая сетка.
//
// Для каждого паттерна, который реально встретился в загруженных
// исторических данных, прогоняет simulate() пять раз — по одному разу на
// каждое значение HORIZON_BACKTEST_GRID (5/10/20/30/50), подставляя его
// ТОЛЬКО для этого паттерна через SimulatorOptions.horizonOverrideByPattern
// (см. simulator.ts) — все остальные паттерны в это время резолвятся своим
// обычным, уже назначенным горизонтом, так что один прогон не искажает
// сигналы, порождённые для другого паттерна.
//
// Как читать таблицу (см. верхний комментарий pattern-horizon.ts,
// "минимальный горизонт, на котором доля timeout не доминирует и
// winRate/R стабилизируются"): двигаясь слева направо по строкам одного
// паттерна, ищите первый горизонт, на котором timeoutRate перестаёт резко
// падать, а averageR/winRate перестают заметно расти при увеличении
// горизонта дальше — это и есть "минимальный горизонт, на котором паттерн
// уже успевает отработать". Слишком МАЛЕНЬКИЙ горизонт по сравнению с этой
// точкой обычно виден как высокий timeoutRate; горизонт БОЛЬШЕ этой точки
// обычно почти не меняет метрики (паттерн уже резолвился раньше) — то есть
// увеличивать его дальше без причины не нужно (лишний хвост в
// maxHorizonReserve, см. simulator.ts).
//
// Результат этого прогона — вход для РУЧНОГО решения: перенести
// выбранное значение горизонта из этой таблицы в HORIZON_BARS_BY_CLASS
// (decision/pattern-horizon.ts) как переопределение класса для конкретного
// паттерна (сейчас класс общий на всю группу short/medium/long) и заполнить
// колонку "Backtest: лучший expiryBars" в pattern-audit-checklist.md.
// Скрипт сам ничего не переписывает — только печатает таблицу.
//
// Запуск: tsx backtest/horizon-calibration.ts --symbol=EURUSD --from=2025-01-01 --to=2025-06-01 --timeframe=15m

import { loadHistory } from './data-loader';
import { resample } from './resampler';
import { simulate } from './simulator';
import { computeMetrics } from './metrics';
import { DEFAULT_BACKTEST_CONFIG } from './config';
import { HORIZON_BACKTEST_GRID } from '@/decision/pattern-horizon';
import { timeframeSchema } from '@/types/domain';
import type { Timeframe } from '@/types/domain';

interface CliArgs {
  symbol: string;
  from: string;
  to: string;
  timeframe: string;
  windowSize: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0 && arg.startsWith('--')) {
      map.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
    }
  }
  return {
    symbol: map.get('symbol') ?? 'BTCUSDT',
    from: map.get('from') ?? '2025-01-01',
    to: map.get('to') ?? '2025-06-01',
    timeframe: map.get('timeframe') ?? '15m',
    windowSize: parseInt(map.get('window') ?? String(DEFAULT_BACKTEST_CONFIG.windowSize), 10),
  };
}

function pctStr(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const tfResult = timeframeSchema.safeParse(args.timeframe);
  if (!tfResult.success) {
    console.error(`Invalid timeframe: ${args.timeframe}. Valid: ${timeframeSchema.options.join(', ')}`);
    process.exit(1);
  }
  const timeframe: Timeframe = tfResult.data;

  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    console.error('Invalid --from/--to. Use YYYY-MM-DD, --from before --to.');
    process.exit(1);
  }

  console.log(`\nLoading 1m history: ${args.symbol} ${args.from} \u2192 ${args.to}`);
  const candles1m = await loadHistory({ symbol: args.symbol, fromMs, toMs });
  if (candles1m.length < 100) {
    console.error('Not enough candles for calibration (need at least 100)');
    process.exit(1);
  }
  const candles = resample(candles1m, timeframe);
  console.log(`Resampled to ${timeframe}: ${candles.length} candles`);

  const baseOptions = {
    symbol: args.symbol,
    timeframe,
    indicatorConfig: { ...DEFAULT_BACKTEST_CONFIG.indicatorConfig },
    atrMultiplier: DEFAULT_BACKTEST_CONFIG.atrMultiplier,
    activeFeatures: [...DEFAULT_BACKTEST_CONFIG.activeFeatures],
    barsToResolve: DEFAULT_BACKTEST_CONFIG.barsToResolve,
    windowSize: args.windowSize,
    // Сетка — диагностический инструмент, не про качество out-of-sample
    // обобщения: считаем метрики по всей истории целиком (inSampleRatio=1),
    // а не по 70%-срезу, как основной бэктест в index.ts.
    inSampleRatio: 1,
  };

  console.log('Discovering which patterns actually fired in this data set...');
  const baseline = simulate(candles, baseOptions);
  const patternNames = new Set<string>();
  for (const t of baseline) {
    // BUGFIX (попутно обнаружено при аудите): Signal.pattern — это уже
    // готовая строка (PatternName | null), не объект — см. тот же фикс в
    // simulator.ts. Было signal.pattern?.name (всегда undefined).
    if (t.signal.pattern) patternNames.add(t.signal.pattern);
  }

  if (patternNames.size === 0) {
    console.log(
      'Ни один классифицированный паттерн не сработал на этом историческом ' +
        'файле — калибровать нечего (сигналы без паттерна всегда используют ' +
        'общий фолбэк-горизонт, см. barsToResolve в SimulatorOptions).',
    );
    return;
  }

  console.log(`Found ${patternNames.size} pattern(s): ${[...patternNames].sort().join(', ')}\n`);

  const header = ['Pattern', 'Horizon', 'Trades', 'WinRate', 'TimeoutRate', 'AvgR', 'AvgWinR'];
  console.log(header.join('\t'));
  console.log('\u2500'.repeat(90));

  for (const patternName of [...patternNames].sort()) {
    for (const horizon of HORIZON_BACKTEST_GRID) {
      const trades = simulate(candles, {
        ...baseOptions,
        horizonOverrideByPattern: { [patternName]: horizon },
      });
      const patternTrades = trades.filter((t) => t.signal.pattern === patternName);
      const m = computeMetrics(patternTrades);
      const timeoutRate = m.totalTrades > 0 ? m.timeouts / m.totalTrades : 0;

      console.log(
        [
          patternName,
          String(horizon),
          String(m.totalTrades),
          m.totalTrades > 0 ? pctStr(m.winRate) : 'n/a',
          m.totalTrades > 0 ? pctStr(timeoutRate) : 'n/a',
          m.totalTrades > 0 ? m.averageR.toFixed(3) : 'n/a',
          m.wins > 0 ? m.averageWinR.toFixed(3) : 'n/a',
        ].join('\t'),
      );
    }
    console.log('\u2500'.repeat(90));
  }

  console.log(
    '\nЭто СЫРЫЕ метрики за один прогон одного исторического файла — перед ' +
      'тем, как переносить число в HORIZON_BARS_BY_CLASS, стоит повторить ' +
      'на нескольких символах/периодах и не полагаться на один-единственный ' +
      'прогон (тот же принцип, что и Walk-Forward протокол в ' +
      'docs/audit/WALK_FORWARD_PROTOCOL.md — не переобучаться на одном срезе ' +
      'истории, разглядывая его вручную).',
  );
}

main().catch((err: unknown) => {
  console.error('Horizon calibration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
