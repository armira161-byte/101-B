import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BacktestMetrics, SplitMetrics } from './metrics';
import type { SimulatedTrade } from './simulator';
import type { ForwardTestReport } from './change-registry';

export interface ReportOptions {
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
  outputDir: string;
}

export function generateReport(
  trades: SimulatedTrade[],
  split: SplitMetrics,
  forwardTest: ForwardTestReport,
  options: ReportOptions,
): void {
  printConsoleReport(split, forwardTest, options);
  writeMarkdownReport(trades, split, forwardTest, options);
  writeJsonReport(trades, split, forwardTest, options);
}

const FORWARD_TEST_VERDICT_LABEL: Record<ForwardTestReport['verdict'], string> = {
  'insufficient-data': 'НЕДОСТАТОЧНО ДАННЫХ — вывод делать нельзя',
  'below-breakeven': 'НИЖЕ точки безубыточности',
  'above-breakeven-not-significant': 'выше безубытка, но статистически незначимо',
  'significantly-above-breakeven': 'значимо выше точки безубыточности',
};

function printForwardTestSection(ft: ForwardTestReport, line: string): void {
  console.log('  FORWARD-TEST (протокол против переобучения, см. п.5 аудита)');
  console.log(line);
  console.log(`  Заморожено:        ${ft.freezeAtIso}`);
  console.log(`  Сделок с этой даты: ${ft.forwardTradeCount} (решённых: ${ft.decidedCount})`);
  if (ft.hasEnoughSamples) {
    console.log(`  Win Rate:           ${(ft.metrics.winRate * 100).toFixed(1)}%`);
    console.log(`  Wilson lower bound: ${((ft.reliableWinRateLowerBound ?? 0) * 100).toFixed(1)}%`);
    console.log(`  Безубыток:          ${(ft.breakevenWinRate * 100).toFixed(2)}%`);
  }
  console.log(`  Вердикт:            ${FORWARD_TEST_VERDICT_LABEL[ft.verdict]}`);
  if (ft.verdict === 'insufficient-data') {
    console.log(
      '  \u26A0 Показанный выше IN-SAMPLE/OUT-OF-SAMPLE бэктест — ретроспектива на',
    );
    console.log(
      '    уже существовавших данных. Он НЕ подтверждает, что текущая логика',
    );
    console.log(
      '    прибыльна вперёд. См. docs/audit/WALK_FORWARD_PROTOCOL.md.',
    );
  }
  console.log(line);
}

function printConsoleReport(split: SplitMetrics, forwardTest: ForwardTestReport, options: ReportOptions): void {
  const line = '\u2500'.repeat(52);
  console.log('\n' + '\u2550'.repeat(52));
  console.log('  BACKTEST REPORT');
  console.log('\u2550'.repeat(52));
  console.log(`  Symbol:      ${options.symbol}`);
  console.log(`  Timeframe:   ${options.timeframe}`);
  console.log(`  Period:      ${options.from} \u2192 ${options.to}`);
  // Refactor variant A, Фаза 5: единого "payout" на весь прогон больше
  // нет (Фаза 4 убрала фиксированную выплату из экономики демо-счёта) —
  // доходность у каждой сделки своя (см. Average Return/Average Win R
  // ниже, посчитанные от реальной геометрии входа/выхода).
  console.log(line);

  for (const [label, metrics] of [
    ['IN-SAMPLE (70%)', split.inSample],
    ['OUT-OF-SAMPLE (30%)', split.outOfSample],
    ['ALL', split.all],
  ] as [string, BacktestMetrics][]) {
    if (metrics.totalTrades === 0) continue;
    console.log(`  ${label}`);
    printMetricsBlock(metrics, line);
  }

  printForwardTestSection(forwardTest, line);

  console.log('\u2550'.repeat(52) + '\n');
}

function printMetricsBlock(metrics: BacktestMetrics, line: string): void {
  console.log(`  Trades:         ${metrics.totalTrades}`);
  console.log(`  Win Rate:        ${(metrics.winRate * 100).toFixed(1)}%`);
  console.log(`  Average Return:  ${metrics.averageR >= 0 ? '+' : ''}${metrics.averageR.toFixed(2)}R`);
  console.log(`  Average Win R:   ${metrics.wins > 0 ? '+' + metrics.averageWinR.toFixed(2) + 'R' : 'n/a (no wins)'}`);
  console.log(`  Brier Score:     ${metrics.brierScore.toFixed(4)}`);
  console.log(`  Max Drawdown:    ${metrics.maxDrawdownR.toFixed(2)}R`);
  console.log(`  Max Loss Streak: ${metrics.maxConsecutiveLosses}`);
  console.log(
    `  Profit Factor:   ${metrics.profitFactor === Infinity ? '\u221E' : metrics.profitFactor.toFixed(2)}`,
  );
  console.log(line);
}

function writeMarkdownReport(
  trades: SimulatedTrade[],
  split: SplitMetrics,
  forwardTest: ForwardTestReport,
  options: ReportOptions,
): void {
  const lines: string[] = [];
  lines.push('# Backtest Report');
  lines.push('');
  lines.push('## Parameters');
  lines.push(`- **Symbol:** ${options.symbol}`);
  lines.push(`- **Timeframe:** ${options.timeframe}`);
  lines.push(`- **Period:** ${options.from} \u2192 ${options.to}`);
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push('');

  for (const [label, metrics] of [
    ['In-Sample (70%)', split.inSample],
    ['Out-of-Sample (30%)', split.outOfSample],
    ['All', split.all],
  ] as [string, BacktestMetrics][]) {
    if (metrics.totalTrades === 0) continue;
    lines.push(`## ${label}`);
    pushMetricsTable(lines, metrics);
    lines.push('');
  }

  lines.push('## Forward-Test (протокол против переобучения, п.5 аудита)');
  lines.push('');
  lines.push(
    'Раздел выше (In-Sample/Out-of-Sample) — ретроспектива на уже ' +
      'существовавших данных: её можно пересчитывать сколько угодно раз, ' +
      'подбирая параметры под один и тот же исторический файл, и это НЕ ' +
      'защищает от переобучения через сам процесс ручного аудита ' +
      '(см. docs/audit/WALK_FORWARD_PROTOCOL.md). Раздел ниже считает ' +
      'метрики только по сделкам, вошедшим строго ПОСЛЕ момента заморозки ' +
      'действующего набора правок — то есть на данных, которые физически ' +
      'не могли использоваться при разработке этих правок.',
  );
  lines.push('');
  lines.push(`- **Заморожено:** ${forwardTest.freezeAtIso}`);
  lines.push(`- **Сделок после заморозки:** ${forwardTest.forwardTradeCount} (решённых: ${forwardTest.decidedCount})`);
  lines.push(`- **Вердикт:** ${FORWARD_TEST_VERDICT_LABEL[forwardTest.verdict]}`);
  if (forwardTest.hasEnoughSamples) {
    lines.push(`- **Win Rate:** ${(forwardTest.metrics.winRate * 100).toFixed(1)}%`);
    lines.push(
      `- **Wilson lower bound:** ${((forwardTest.reliableWinRateLowerBound ?? 0) * 100).toFixed(1)}%`,
    );
    lines.push(`- **Точка безубыточности:** ${(forwardTest.breakevenWinRate * 100).toFixed(2)}%`);
  } else {
    lines.push('- Недостаточно решённых сделок после даты заморозки для статистически осмысленного вывода.');
  }
  lines.push('');

  lines.push('## Trades (first 20)');
  lines.push('| # | Time | Dir | Score | Prob | Outcome | Spread Cost (diag.) | Sample |');
  lines.push('|---|------|-----|-------|------|---------|----------|--------|');
  const sample = trades.slice(0, 20);
  sample.forEach((t, idx) => {
    lines.push(
      `| ${idx + 1} | ${new Date(t.entryTime * 1000).toISOString().slice(0, 16)} | ${t.signal.direction} | ${t.signal.score} | ${(t.signal.calibratedProbability ?? 0).toFixed(2)} | ${t.outcome} | ${t.spreadCostR.toFixed(3)} | ${t.inSample ? 'IS' : 'OOS'} |`,
    );
  });
  if (trades.length > 20) {
    lines.push(`| ... | *${trades.length - 20} more trades in JSON output* | | | | | | |`);
  }
  lines.push('');

  const filepath = join(
    options.outputDir,
    `backtest-${options.symbol}-${options.timeframe}.md`,
  );
  mkdirSync(dirname(filepath), { recursive: true });
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  console.log(`  Markdown report: ${filepath}`);
}

function pushMetricsTable(lines: string[], m: BacktestMetrics): void {
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Trades | ${m.totalTrades} |`);
  lines.push(`| Wins | ${m.wins} |`);
  lines.push(`| Losses | ${m.losses} |`);
  lines.push(`| Timeouts | ${m.timeouts} |`);
  lines.push(`| Win Rate | ${(m.winRate * 100).toFixed(1)}% |`);
  lines.push(`| Average Return | ${m.averageR >= 0 ? '+' : ''}${m.averageR.toFixed(2)}R |`);
  lines.push(`| Average Win R | ${m.wins > 0 ? '+' + m.averageWinR.toFixed(2) + 'R' : 'n/a (no wins)'} |`);
  lines.push(`| Brier Score | ${m.brierScore.toFixed(4)} |`);
  lines.push(`| Max Drawdown | ${m.maxDrawdownR.toFixed(2)}R |`);
  lines.push(`| Max Loss Streak | ${m.maxConsecutiveLosses} |`);
  lines.push(`| Profit Factor | ${m.profitFactor === Infinity ? '\u221E' : m.profitFactor.toFixed(2)} |`);
}

function writeJsonReport(
  trades: SimulatedTrade[],
  split: SplitMetrics,
  forwardTest: ForwardTestReport,
  options: ReportOptions,
): void {
  const report = {
    parameters: {
      symbol: options.symbol,
      timeframe: options.timeframe,
      from: options.from,
      to: options.to,
      generatedAt: new Date().toISOString(),
    },
    metrics: {
      inSample: serializeMetrics(split.inSample),
      outOfSample: serializeMetrics(split.outOfSample),
      all: serializeMetrics(split.all),
    },
    forwardTest: {
      freezeAtMs: forwardTest.freezeAtMs,
      freezeAtIso: forwardTest.freezeAtIso,
      forwardTradeCount: forwardTest.forwardTradeCount,
      decidedCount: forwardTest.decidedCount,
      breakevenWinRate: forwardTest.breakevenWinRate,
      reliableWinRateLowerBound: forwardTest.reliableWinRateLowerBound,
      hasEnoughSamples: forwardTest.hasEnoughSamples,
      verdict: forwardTest.verdict,
      metrics: serializeMetrics(forwardTest.metrics),
    },
    trades: trades.map((t) => ({
      entryTime: t.entryTime,
      candleIndex: t.candleIndex,
      outcome: t.outcome,
      direction: t.signal.direction,
      score: t.signal.score,
      calibratedProbability: t.signal.calibratedProbability,
      entryPrice: t.signal.entryPrice,
      // BUGFIX (попутно обнаружено, Фаза 5): было t.signal.expiryBars —
      // такого поля в Signal (types/domain.ts) уже нет, это устаревшее имя
      // до появления recommendedExpiry/barsToResolve.
      recommendedExpiry: t.signal.recommendedExpiry,
      barsToResolve: t.signal.barsToResolve,
      reason: t.signal.reason,
      pattern: t.signal.pattern,
      spreadCostR: t.spreadCostR,
      rMultiple: t.rMultiple,
      inSample: t.inSample,
      featureVector: t.signal.featureVector,
    })),
  };

  const filepath = join(
    options.outputDir,
    `backtest-${options.symbol}-${options.timeframe}.json`,
  );
  mkdirSync(dirname(filepath), { recursive: true });
  writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  JSON report:     ${filepath}`);
}

function serializeMetrics(m: BacktestMetrics) {
  return { ...m, profitFactor: isFinite(m.profitFactor) ? m.profitFactor : null };
}
