import type { SimulatedTrade } from './simulator';
import { getSessionRegime, type SessionRegime } from '@/compute/session-regime';
import { nextLossStreak } from '@/decision/loss-streak-guard';

export interface ReliabilityBin {
  binStart: number;
  binEnd: number;
  count: number;
  avgPredicted: number;
  avgActual: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  averageR: number;
  // Refactor variant A, Фаза 5 — средний R ТОЛЬКО по победам (rMultiple
  // среди trades с outcome==='win'). Нужен отдельно от averageR (который
  // усредняет по всей выборке, включая нулевые timeout и loss=-1) как
  // единственный содержательный вход для честной точки безубыточности —
  // см. change-registry.ts::computeForwardTestReport. 0, если побед нет.
  averageWinR: number;
  brierScore: number;
  maxDrawdownR: number;
  profitFactor: number;
  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): до этого
  // поля в бэктесте не было НИКАКОЙ метрики серийности вообще —
  // winRate/profitFactor усредняют по всей выборке и не видят порядок
  // сделок, поэтому нельзя было даже ИЗМЕРИТЬ, помогает ли то или иное
  // изменение именно с кластеризацией убытков, а не просто с общим
  // винрейтом (high-volatility régime автокоррелирован — см.
  // signal-filters.ts::HIGH_VOL_GATE_* — один и тот же winRate может
  // скрывать очень разное распределение длин убыточных серий). Считается
  // той же чистой nextLossStreak(), что и живой движок (см.
  // decision/loss-streak-guard.ts) — единый источник правды для обоих
  // путей, а не два независимых расчёта серийности.
  maxConsecutiveLosses: number;
  reliabilityBins: ReliabilityBin[];
}

export interface SplitMetrics {
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  all: BacktestMetrics;
}

// BUGFIX (аудит 2026-09-13, "R-модель бэктеста не совпадает с реальной
// экономикой демо-счёта"): здесь стояли WIN_R=2/LOSS_R=-1, затем (тот же
// аудит) — WIN_R=profitPercent/100/LOSS_R=-1/timeout=0, подражая
// бинарно-опционной экономике демо-счёта тех времён.
//
// Refactor variant A, Фаза 5 — та экономика, которой подражала эта модель,
// в проекте больше не существует (Фаза 4 удалила
// `pnl = stake * profitPercent / 100` из useDemoAccountStore.ts ПОЛНОСТЬЮ,
// без альтернативной ветки). Оставлять здесь расчёт averageR по
// вымышленному фиксированному payout значило бы калибровать Фазу 5
// (подбор горизонта "по данным") по экономике, которой в продукте больше
// нет — тот самый разрыв, который и весь этот рефакторинг должен был
// устранить. Теперь averageR/profitFactor/maxDrawdownR считаются от
// РЕАЛЬНОГО SimulatedTrade.rMultiple — той же формулы позиционного P&L,
// что и демо-счёт/live-движок (exitPrice/entryPrice/stopDistance, см.
// simulator.ts). profitPercent как параметр этой функции полностью
// убран — все три сюда переданных исхода уже несут свою настоящую
// доходность, ничего вычислять из внешнего payout не нужно.
export function computeMetrics(trades: SimulatedTrade[]): BacktestMetrics {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const timeouts = trades.filter((t) => t.outcome === 'timeout').length;

  // BUGFIX (аудит 2026-09-13, тот же разбор): раньше winRate = wins/total
  // включал timeouts в знаменатель — единственное место во всём проекте,
  // считавшее винрейт так; useAnalyticsStore.recomputeStats() (реальные
  // демо-сделки, видимые пользователю) и computeForwardTestReport() из
  // change-registry.ts, использующий это же поле для вердикта, всегда
  // исключают timeout из знаменателя (timeout — не выигрыш и не проигрыш,
  // ставка просто возвращается). Расхождение делало winRate здесь
  // занижённым на любой выборке с ненулевыми timeout — и напрямую искажало
  // вердикт forward-теста в сторону "below-breakeven" сильнее, чем
  // обосновано данными.
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : 0;

  const rValues = trades.map((t) => t.rMultiple);
  const averageR = total > 0 ? rValues.reduce((a, b) => a + b, 0) / total : 0;

  const winRValues = trades.filter((t) => t.outcome === 'win').map((t) => t.rMultiple);
  const averageWinR = winRValues.length > 0 ? winRValues.reduce((a, b) => a + b, 0) / winRValues.length : 0;

  const brierScore =
    total > 0
      ? trades.reduce((sum, t) => {
          const prob = t.signal.calibratedProbability ?? 0.5;
          const actual = t.outcome === 'win' ? 1 : 0;
          return sum + (prob - actual) ** 2;
        }, 0) / total
      : 0;

  let cumulative = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rValues) {
    cumulative += r;
    peak = Math.max(peak, cumulative);
    maxDD = Math.max(maxDD, peak - cumulative);
  }

  const grossProfit = rValues.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // АУДИТ 2026-09-13: серия считается в исходном хронологическом порядке
  // `trades` (как переданы вызывающим кодом — computeSplitMetrics/
  // computeMetricsBySession передают сюда уже отфильтрованные, но
  // ПОРЯДОК-СОХРАНЯЮЩИЕ подмассивы, см. .filter() ниже в этом файле), а не
  // пересортировывается здесь — как и остальные метрики в этой функции.
  // 'timeout' пропускается (не продолжает и не обрывает серию) — та же
  // конвенция, что уже использует winRate чуть выше (decided = wins +
  // losses).
  let streak = 0;
  let maxConsecutiveLosses = 0;
  for (const t of trades) {
    if (t.outcome !== 'win' && t.outcome !== 'loss') continue;
    streak = nextLossStreak(streak, t.outcome);
    if (streak > maxConsecutiveLosses) maxConsecutiveLosses = streak;
  }

  return {
    totalTrades: total,
    wins,
    losses,
    timeouts,
    winRate,
    averageR,
    averageWinR,
    brierScore,
    maxDrawdownR: maxDD,
    profitFactor,
    maxConsecutiveLosses,
    reliabilityBins: computeReliabilityBins(trades),
  };
}

export function computeSplitMetrics(trades: SimulatedTrade[]): SplitMetrics {
  const inSample = trades.filter((t) => t.inSample);
  const outOfSample = trades.filter((t) => !t.inSample);
  return {
    inSample: computeMetrics(inSample),
    outOfSample: computeMetrics(outOfSample),
    all: computeMetrics(trades),
  };
}

// Задача 1.2.3 — group trades by the same session-regime classification
// signal-builder.ts's sessionFilter gate uses (getSessionRegime), so
// backtest/report.ts can show whether e.g. the Asian session really does
// have a worse winRate on a given pair — measured from data, not assumed.
// 'closed' is included for completeness even though signal-builder.ts's
// gate never blocks on it (see isSessionAllowed) — a nonzero count there
// would itself be worth investigating.
export function computeMetricsBySession(
  trades: SimulatedTrade[],
): Record<SessionRegime, BacktestMetrics> {
  const groups: Record<SessionRegime, SimulatedTrade[]> = {
    sydney: [], tokyo: [], london: [], newyork: [], overlap: [], closed: [],
  };
  for (const trade of trades) {
    const session = getSessionRegime(trade.signal.time * 1000);
    groups[session].push(trade);
  }
  return {
    sydney: computeMetrics(groups.sydney),
    tokyo: computeMetrics(groups.tokyo),
    london: computeMetrics(groups.london),
    newyork: computeMetrics(groups.newyork),
    overlap: computeMetrics(groups.overlap),
    closed: computeMetrics(groups.closed),
  };
}

function computeReliabilityBins(trades: SimulatedTrade[]): ReliabilityBin[] {
  const numBins = 10;
  const bins: ReliabilityBin[] = [];

  for (let i = 0; i < numBins; i++) {
    const binStart = i / numBins;
    const binEnd = (i + 1) / numBins;
    const inBin = trades.filter((t) => {
      const prob = t.signal.calibratedProbability ?? 0.5;
      if (i === numBins - 1) return prob >= binStart && prob <= binEnd;
      return prob >= binStart && prob < binEnd;
    });

    bins.push({
      binStart,
      binEnd,
      count: inBin.length,
      avgPredicted:
        inBin.length > 0
          ? inBin.reduce((s, t) => s + (t.signal.calibratedProbability ?? 0.5), 0) / inBin.length
          : 0,
      avgActual:
        inBin.length > 0 ? inBin.filter((t) => t.outcome === 'win').length / inBin.length : 0,
    });
  }

  return bins;
}
