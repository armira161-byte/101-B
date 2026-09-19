import type {
  Candle,
  Signal,
  SignalOutcome,
  Timeframe,
  IndicatorConfig,
  FeatureName,
} from '@/types/domain';
import { runEngine } from '@/engine/analysisEngine';
import { resolveOutcome } from '@/decision/outcome-scheduler';
import { estimateSpread } from '@/decision/spread-estimate';
import { applySpreadToOutcome } from '@/decision/apply-spread';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import { isSuppressedByCooldown, pruneResolvedSignals, type RecentSignalRecord } from '@/decision/signal-cooldown';
import { nextLossStreak, requiresStrongOnlyForLossStreak } from '@/decision/loss-streak-guard';
import { HORIZON_BARS_BY_CLASS } from '@/decision/pattern-horizon';

export interface SimulatedTrade {
  signal: Signal;
  outcome: SignalOutcome;
  entryTime: number;
  candleIndex: number;
  spreadCostR: number;
  // Refactor variant A, Фаза 5 — реальная доходность сделки в единицах
  // риска (R), а не старый бинарно-опционный WIN_R=profitPercent/100 /
  // LOSS_R=-1. Считается от той же геометрии входа/выхода, что и позиционный
  // P&L демо-счёта (useDemoAccountStore.ts::applyResolvedOutcome):
  //   rMultiple = (exitPrice - entryPrice) * sign(direction) / stopDistance
  // Алгебраическое следствие этой формулы (не совпадение): попадание
  // именно в stopLoss всегда даёт rMultiple === -1 (это и есть определение
  // риска), take_profit/timeout — пропорционально пройденному расстоянию.
  // 0 для "плоского" timeout (см. applySpreadToOutcome().isFlatTimeout) —
  // то же зануление, что демо-счёт применяет к pnl в этом случае.
  rMultiple: number;
  inSample: boolean;
}

export interface SimulatorOptions {
  symbol: string;
  timeframe: Timeframe;
  indicatorConfig: IndicatorConfig;
  atrMultiplier: number;
  activeFeatures: FeatureName[];
  // Refactor variant A, Фаза 2/5 — раньше это было ЕДИНСТВЕННЫМ горизонтом
  // резолва для абсолютно всех сигналов. Теперь горизонт паттерн-специфичен
  // (signal.barsToResolve, см. decision/pattern-horizon.ts) — это поле
  // используется только (а) как barsToResolve-фолбэк, который runEngine()
  // передаёт дальше в signal-builder.ts для сигналов БЕЗ распознанного
  // паттерна (evidence.pattern === null — сигнал на одних индикаторах, у
  // которого нет гипотезы горизонта в чек-листе), и (б) как один из
  // источников резерва свечей в конце окна (см. maxHorizonReserve ниже) —
  // само по себе больше не определяет длину futureCandles ни для одного
  // классифицированного паттерна.
  barsToResolve: number;
  windowSize: number;
  inSampleRatio: number;
  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): опционально
  // эмулирует в бэктесте тот же предохранитель, что и живой DecisionEngine
  // (см. decision/loss-streak-guard.ts, DecisionEngine.lossStreakGuardEnabled
  // — там включён по умолчанию). Здесь, наоборот, по умолчанию ВЫКЛЮЧЕН
  // (undefined/false): существующие прогоны бэктеста и backtest.test.ts не
  // должны менять результат, пока это явно не запрошено — включайте, чтобы
  // сравнить metrics.maxConsecutiveLosses/winRate до и после.
  lossStreakGuardEnabled?: boolean;
  // Refactor variant A, Фаза 5 — пер-паттерновая калибровочная сетка
  // (см. decision/pattern-horizon.ts::HORIZON_BACKTEST_GRID и
  // backtest/horizon-calibration.ts). Когда задано, для сигналов с
  // signal.pattern?.name, присутствующим здесь как ключ, ПОДМЕНЯЕТ
  // maxHorizonBarsForPattern()-значение, уже зашитое в signal.barsToResolve
  // сигнал-билдером, — так можно прогнать один и тот же исторический файл
  // с горизонтом {5,10,20,30,50} для ОДНОГО паттерна, не трогая остальные.
  // Не влияет на сигналы без распознанного паттерна (см. barsToResolve
  // выше) и не меняет то, ЧТО породило сигнал — только на сколько баров
  // резолвится его исход.
  horizonOverrideByPattern?: Partial<Record<string, number>>;
}

export function simulate(candles: Candle[], options: SimulatorOptions): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  const tfSeconds = TIMEFRAME_SECONDS[options.timeframe];

  const warmup =
    Math.max(
      options.indicatorConfig.emaSlow,
      options.indicatorConfig.bbPeriod,
      options.indicatorConfig.macdSlow,
      options.indicatorConfig.rsiPeriod,
      options.indicatorConfig.atrPeriod,
    ) + 5;

  const minStart = Math.max(warmup, options.windowSize);
  const splitIndex = Math.floor((candles.length - minStart) * options.inSampleRatio) + minStart;

  // Refactor variant A, Фаза 5. Раньше цикл резервировал ровно
  // options.barsToResolve свечей в хвосте — корректно, пока горизонт был
  // одной глобальной константой на весь продукт. Теперь горизонт
  // паттерн-специфичен и доходит до 30 баров (Группа "длинные" —
  // order-block-continuation, гармоники, Three Methods и т.д., см.
  // HORIZON_BARS_BY_CLASS), а на калибровочном прогоне (Фаза 5) — и вовсе
  // до любого значения из horizonOverrideByPattern. Резервируем максимум из
  // всех горизонтов, которые в принципе МОГУТ понадобиться в этом прогоне,
  // чтобы длинные паттерны у самого конца исторического файла не обрубались
  // на резолве раньше времени (что раньше маскировалось под их же timeout).
  const maxHorizonReserve = Math.max(
    options.barsToResolve,
    ...Object.values(HORIZON_BARS_BY_CLASS),
    ...Object.values(options.horizonOverrideByPattern ?? {}).filter(
      (v): v is number => typeof v === 'number',
    ),
  );

  // BUGFIX (аудит 2026-09-05): без истории уже выданных сигналов бэктест
  // молча "усредняется" в ту же зону так же, как это делал живой движок в
  // реальном инциденте (3 BUY подряд за 2 минуты почти на одной цене) — это
  // завышает число сделок и искажает winrate/статистику relative к тому,
  // что видел бы реальный пользователь после фикса в decision/engine.ts.
  let recentSignals: RecentSignalRecord[] = [];
  // Тот же, независимый от cooldown/chop-guard предохранитель, что и в
  // живом движке — см. lossStreakGuardEnabled выше. Хронологический,
  // т.к. цикл ниже уже идёт по возрастающему i (последовательные закрытые
  // свечи), в том же порядке, в каком уже накапливается recentSignals.
  let lossStreak = 0;

  for (let i = minStart; i < candles.length - maxHorizonReserve; i++) {
    const window = candles.slice(i - options.windowSize + 1, i + 1);
    const lastCandle = candles[i];
    const serverNowMs = (lastCandle.time + tfSeconds) * 1000;

    const { signal } = runEngine({
      symbolId: options.symbol,
      timeframe: options.timeframe,
      candles: window,
      config: options.indicatorConfig,
      atrMultiplier: options.atrMultiplier,
      activeFeatures: options.activeFeatures,
      calibration: null,
      tick: null,
      barsToResolve: options.barsToResolve,
    });

    if (!signal) continue;

    if (
      options.lossStreakGuardEnabled &&
      requiresStrongOnlyForLossStreak(lossStreak) &&
      signal.strength !== 'strong'
    ) {
      continue;
    }

    recentSignals = pruneResolvedSignals(recentSignals, lastCandle.time);
    const suppressed = isSuppressedByCooldown({
      recent: recentSignals,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      candleTime: lastCandle.time,
      atrValue: signal.indicators.atr,
    });
    if (suppressed) continue;

    // Фаза 5 — калибровочный оверрайд горизонта для конкретного паттерна
    // (см. horizonOverrideByPattern выше). signal.barsToResolve уже
    // паттерн-специфичен (проставлен signal-builder.ts::buildSignal() через
    // maxHorizonBarsForPattern(), Фаза 2/3) — здесь мы ТОЛЬКО опционально
    // подменяем его для сетки {5,10,20,30,50}, ничего не решая заново.
    // BUGFIX (попутно обнаружено при аудите): signal.pattern — это уже
    // готовая строка (Signal.pattern: PatternName | null, см.
    // types/domain.ts и signal-builder.ts: `pattern: evidence.pattern?.name
    // ?? null`), а не объект с полем .name — тот объект называется
    // evidence.pattern и существует только внутри signal-builder.ts. Было
    // `signal.pattern?.name`, что всегда давало undefined и делало весь
    // horizonOverrideByPattern неработающим.
    const patternName = signal.pattern ?? null;
    const horizonOverride = patternName ? options.horizonOverrideByPattern?.[patternName] : undefined;
    const effectiveHorizon = horizonOverride ?? signal.barsToResolve;

    recentSignals.push({
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      candleTime: lastCandle.time,
      resolvesAtTime: lastCandle.time + effectiveHorizon * tfSeconds,
    });

    const deterministicSignal: Signal = {
      ...signal,
      id: `${options.symbol}:${options.timeframe}:${i}`,
      barsToResolve: effectiveHorizon,
    };

    const futureCandles = candles.slice(i + 1, i + 1 + effectiveHorizon);
    const resolved = resolveOutcome(deterministicSignal, futureCandles);
    if (!resolved) continue;
    // exitPrice/exitReason типизированы опционально в ResolvedOutcome
    // только ради обратной совместимости мест, собирающих его вручную
    // (тесты) — resolveOutcome() всегда заполняет оба поля для любого
    // non-null результата (см. outcome-scheduler.ts), поэтому этот guard
    // не должен срабатывать на живых данных; он здесь только чтобы не
    // проваливать типизацию applySpreadToOutcome() опциональными полями.
    if (resolved.exitPrice === undefined || resolved.exitReason === undefined) continue;

    const { spread } = estimateSpread(options.symbol, null);
    // Фаза 5 — синхронизировано с Фазой 3/4: applySpreadToOutcome() теперь
    // сравнивает спред с фактической ценой ВЫХОДА резолва по уровням
    // (resolved.exitPrice — может быть на любом баре в пределах горизонта),
    // а не с ценой закрытия первой попавшейся будущей свечи (устаревший
    // артефакт close-модели). См. её комментарий: спред больше не
    // понижает 'win'/'loss', только помечает "плоский" timeout.
    const adjusted = applySpreadToOutcome(
      { outcome: resolved.outcome, exitPrice: resolved.exitPrice, exitReason: resolved.exitReason },
      deterministicSignal,
      spread,
    );

    // Фаза 5 — реальный R-мультипликатор от геометрии входа/выхода, той же
    // формулой, что и позиционный pnl демо-счёта (см. комментарий к полю
    // rMultiple выше). "Плоский" timeout зануляется — та же логика, что
    // useDemoAccountStore.ts применяет к pnl в этом случае, а не
    // подставляется как реальная доходность/убыток от рыночного шума.
    const stopDistance = Math.abs(deterministicSignal.entryPrice - deterministicSignal.stopLoss);
    const sign = deterministicSignal.direction === 'buy' ? 1 : -1;
    const rMultiple =
      stopDistance > 0 && !adjusted.isFlatTimeout
        ? ((resolved.exitPrice - deterministicSignal.entryPrice) * sign) / stopDistance
        : 0;

    // См. lossStreakGuardEnabled выше — обновляется независимо от того,
    // включён ли гейт в этом прогоне, чтобы значение metrics.
    // maxConsecutiveLosses не зависело от того, что options содержит
    // (гейт и метрика — два разных, независимо включаемых потребителя
    // одной и той же серии). 'timeout' пропускается — та же конвенция,
    // что и в metrics.ts/decision/loss-streak-guard.ts.
    if (adjusted.outcome === 'win' || adjusted.outcome === 'loss') {
      lossStreak = nextLossStreak(lossStreak, adjusted.outcome);
    }

    trades.push({
      signal: deterministicSignal,
      outcome: adjusted.outcome,
      entryTime: lastCandle.time,
      candleIndex: i,
      spreadCostR: adjusted.spreadCostR,
      rMultiple,
      inSample: i < splitIndex,
    });
  }

  return trades;
}

export function splitTrades(trades: SimulatedTrade[]): {
  inSample: SimulatedTrade[];
  outOfSample: SimulatedTrade[];
} {
  return {
    inSample: trades.filter((t) => t.inSample),
    outOfSample: trades.filter((t) => !t.inSample),
  };
}
