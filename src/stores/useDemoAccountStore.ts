import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Signal, SignalDirection, SignalOutcome, Timeframe, Candle } from '@/types/domain';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
// Refactor variant A ("честная форекс-логика"), Фаза 4.
//
// История этого файла — три последовательных модели исхода, важно не
// откатить назад по ошибке:
//   1. Изначально: касание stopLoss/takeProfit решало исход, выплата —
//      фиксированный profitPercent от ставки (бинарные опционы).
//   2. Предыдущий аудит СВЁЛ это к outcome-scheduler.ts, но "вниз": исход
//      демо-сделки стал источником истины, а outcome-scheduler начал
//      копировать его логику (close следующей свечи vs entry).
//   3. Теперь (вариант А) обе стороны сводятся "вверх": resolveTrade()
//      использует ОБЩИЙ resolveOutcomeByLevels() (тот же модуль, что
//      outcome-scheduler.ts и бэктест), а P&L становится позиционным —
//      positionSize = stake / stopDistance, pnl = positionSize *
//      (exitPrice - entryPrice) * sign(direction). Старый путь
//      `pnl = stake * profitPercent / 100` УДАЛЁН полностью (см. промт,
//      Фаза -1, п.1) — не оставлен как альтернативная ветка/feature-flag.
//      `profitPercent`/`setProfitPercent` в публичном API оставлены (это
//      настройка UI, на которую могут ссылаться существующие экраны) но
//      реально в расчёте pnl больше не участвуют.
import { useAnalyticsStore } from './useAnalyticsStore';
import { updateSignalOutcome as persistSignalOutcome } from '@/lib/signal-persistence';
import { nextLossStreak } from '@/decision/loss-streak-guard';
import {
  resolveOutcomeByLevels,
  resolveOutcomeByTick,
  type ResolvableSignal,
  type ResolvedOutcomeByLevels,
} from '@/decision/resolve-by-levels';
import { getCandlesAfterSignal } from '@/decision/outcome-scheduler';

type Stage = 0 | 1 | 2 | 3;
type InstrumentKey = string;

interface InstrumentMartingaleState {
  stage: Stage;
  halted: boolean;
}

export interface DemoTrade {
  signalId: string;
  stake: number;
  profitPercent: number;
  direction: SignalDirection;
  openedAt: number;
  entryPrice: number | null;
  fallbackEntryPrice: number;
  // BUGFIX (аудит 2026-09-13): спред сигнала на момент открытия сделки —
  // нужен resolveTrade() для того же расчёта, что уже применялся к
  // калибровочной модели (см. decision/apply-spread.ts), но раньше не
  // долетал до баланса демо-счёта. null, если спред не был оценён.
  spread: number | null;
  // Фаза 4: уровни и горизонт удержания сигнала, без которых
  // resolveOutcomeByLevels() резолвить сделку не может — раньше исход
  // определялся ценой закрытия ровно одной свечи (expiryAt), геометрия
  // паттерна вообще не участвовала.
  stopLoss: number;
  takeProfit: number;
  maxHorizonBars: number;
  expiryAt: number;
  symbolId: string;
  timeframe: Timeframe;
  candleTime: number;
  stage: Stage;
  stakeConfigAtOpen: { stage0Amount: number; stageAmounts: [number, number, number] };
}

export interface DemoTradeHistoryEntry {
  signalId: string;
  outcome: 'win' | 'loss' | 'tie';
  pnl: number;
  balanceAfter: number;
  closedAt: number;
  resolutionType?: 'normal' | 'fallback';
  symbolId: string;
  timeframe: Timeframe;
  stage: number;
  seriesReset: 'win' | 'loss_final_stage' | null;
  // Фаза 4/6: то же, что понадобится колонкам exit_price/exit_reason/
  // bars_held/ambiguous_intrabar_touch будущей миграции БД — заполняется
  // здесь заранее, чтобы UI (Фаза 6) мог начать их показывать без ещё
  // одного прохода по этому файлу. Опционально — старые записи истории
  // (до этого поля) этого не имеют.
  exitPrice?: number;
  exitReason?: ResolvedOutcomeByLevels['exitReason'];
  barsHeld?: number;
  ambiguousIntrabarTouch?: boolean;
}

interface LegacyDemoAccountPersistedState {
  balance?: number;
  baseStake?: number;
  stage0Amount?: number;
  stagePercents?: [number, number, number];
  stageAmounts?: [number, number, number];
  consecutiveLosses?: number;
  currentStake?: number;
  martingale?: Record<string, { stage: 0 | 1 | 2 | 3; halted?: boolean }>;
  profitPercent?: number;
  autoTradeEnabled?: boolean;
  martingaleEnabled?: boolean;
  openTrades?: Record<string, unknown>;
  history?: unknown[];
}

interface DemoAccountPersistedShape {
  balance: number;
  stage0Amount: number;
  stageAmounts: [number, number, number];
  profitPercent: number;
  autoTradeEnabled: boolean;
  martingaleEnabled: boolean;
  martingale: Record<InstrumentKey, InstrumentMartingaleState>;
  openTrades: Record<string, unknown>;
  history: unknown[];
  // Опционально: отсутствует у уже смигрировавших пользователей (version=6,
  // ниже не бампается ради этого поля) — merge со стороны zustand.persist
  // сохраняет initial-state дефолт (0) из useDemoAccountStore ниже, когда
  // это поле отсутствует в сохранённом JSON. См. currentLossStreak в
  // DemoAccountState.
  currentLossStreak?: number;
}

interface DemoAccountState {
  balance: number;
  stage0Amount: number;
  stageAmounts: [number, number, number];
  profitPercent: number;
  autoTradeEnabled: boolean;
  // Переключатель системы мартингейла (только демо-счёт). true — поведение
  // как раньше (удвоение/повышение ставки по стадиям 0-3 после убытка).
  // false — каждая убыточная сделка закрывается в минус ставки, но стадия
  // мартингейла НЕ повышается: следующая ставка остаётся равна stage0Amount.
  martingaleEnabled: boolean;
  martingale: Record<InstrumentKey, InstrumentMartingaleState>;
  openTrades: Record<string, DemoTrade>;
  history: DemoTradeHistoryEntry[];
  // АУДИТ 2026-09-13 ("не допустить 3 убыточные сделки подряд"): подряд
  // идущие РЕАЛЬНЫЕ убытки на демо-счёте (across all instruments — это
  // общая, не per-instrument серия, в отличие от martingale/stage, которые
  // per-instrument). Обновляется исключительно в checkExpiries()/
  // resolveFromHistory() (там же, где решается pnl), сбрасывается в
  // resetAccount(). Не путать с удалённым legacy-полем consecutiveLosses
  // (см. migrateDemoAccountState, version<2) — это новое, отдельно
  // читаемое поле, а не воскрешение старого мёртвого кода.
  currentLossStreak: number;
  openTrade: (signal: Signal, knownOpenPrice?: number) => void;
  confirmEntryPrice: (symbolId: string, timeframe: Timeframe, candleTime: number, openPrice: number) => void;
  checkExpiries: (candles: Candle[], nowMs: number, symbolId: string, timeframe: Timeframe) => void;
  // Фаза 3/4: живой тик текущей формирующейся свечи может задеть
  // stopLoss/takeProfit ДО закрытия свечи (см. resolveOutcomeByTick в
  // resolve-by-levels.ts) — на M1 это основной сценарий срабатывания
  // стопа. checkExpiries() этого не увидит: она смотрит только на
  // закрытые свечи.
  checkTickLevel: (tick: { price: number; bid?: number; ask?: number }, symbolId: string, timeframe: Timeframe) => void;
  resolveFromHistory: (symbolId: string, timeframe: Timeframe, candles: Candle[]) => void;
  setStage0Amount: (amount: number) => void;
  setStageAmount: (stage: 1 | 2 | 3, amount: number) => void;
  setProfitPercent: (v: number) => void;
  setAutoTradeEnabled: (v: boolean) => void;
  setMartingaleEnabled: (v: boolean) => void;
  setBalance: (v: number) => void;
  resetAccount: () => void;
}

const DEFAULT_BALANCE = 1000;
const DEFAULT_STAGE0_AMOUNT = 10;
const DEFAULT_STAGE_AMOUNTS: [number, number, number] = [25, 50, 100];
// Only used to migrate legacy (pre-v5) persisted state that stored stages 1-3 as percentages.
const DEFAULT_STAGE_PERCENTS_LEGACY: [number, number, number] = [250, 500, 1000];
const DEFAULT_PROFIT_PERCENT = 80;
const MAX_HISTORY = 30;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function instrumentKey(symbolId: string, timeframe: Timeframe): InstrumentKey {
  return `${symbolId}:${timeframe}`;
}

// Тот же маппинг, что уже использовался для DemoTradeHistoryEntry.outcome
// Синхронно (без setTimeout/микротасков) прокидывает результат реальной
// демо-сделки в analytics.signals ("ИСТОРИЯ СИГНАЛОВ") и в БД. Вызывается
// из checkExpiries()/resolveFromHistory() РОВНО в момент закрытия сделки —
// это единственное место, которое теперь выставляет отображаемый/
// сохраняемый outcome сигнала, по которому была открыта демо-сделка.
function syncSignalOutcome(signalId: string, outcome: SignalOutcome): void {
  useAnalyticsStore.getState().updateSignalOutcome(signalId, outcome);
  void persistSignalOutcome(signalId, outcome);
}

export function getStageStake(
  stage: Stage,
  stage0Amount: number,
  stageAmounts: [number, number, number],
): number {
  if (stage === 0) return round2(stage0Amount);
  return round2(stageAmounts[stage - 1]);
}

interface ResolveTradeResult {
  resolved: ResolvedOutcomeByLevels;
  pnl: number;
  balanceAfter: number;
  newMartingale: InstrumentMartingaleState;
  seriesReset: 'win' | 'loss_final_stage' | null;
}

// Refactor variant A, Фаза 4 — единственный резолв исхода демо-сделки,
// через тот же resolveOutcomeByLevels(), что использует live-движок
// (outcome-scheduler.ts) и бэктест. Возвращает null, если горизонт ещё не
// исчерпан и ни один уровень не задет — сделка остаётся открытой, вызывающая
// сторона (checkExpiries/resolveFromHistory) просто не трогает её в этом
// проходе.
// Refactor variant A, Фаза 4 — общая логика "уже известен resolved-исход →
// посчитать позиционный pnl и решить, как двигать мартингейл", вынесена
// отдельно от ТОГО, как этот resolved-исход был получен. Это ядро,
// которое используют оба пути резолва демо-сделки:
//   - resolveTrade() ниже — по закрытым свечам (resolveOutcomeByLevels).
//   - checkTickLevel в create()-теле стора — по живому тику текущей
//     формирующейся свечи (resolveOutcomeByTick), см. resolve-by-levels.ts.
// Дублировать формулу pnl/стадии в обоих местах означало бы ровно ту
// рассинхронизацию двух моделей исхода, которую чинит вся эта редакция.
function applyResolvedOutcome(
  trade: DemoTrade,
  resolved: ResolvedOutcomeByLevels,
  currentState: InstrumentMartingaleState,
  martingaleEnabled: boolean,
): ResolveTradeResult {
  const entryPrice = trade.entryPrice ?? trade.fallbackEntryPrice;

  // Позиционная модель P&L (Фаза 4) взамен удалённого
  // `pnl = stake * profitPercent / 100`: та же ставка распределяется по
  // размеру позиции так, чтобы попадание именно в stopLoss стоило РОВНО
  // stake (это и есть определение риска, который пользователь принял на
  // себя), а попадание в takeProfit или закрытие по timeout — пропорционально
  // реальному пройденному расстоянию.
  const stopDistance = Math.abs(entryPrice - trade.stopLoss);
  const positionSize = stopDistance > 0 ? trade.stake / stopDistance : 0;
  const sign = trade.direction === 'buy' ? 1 : -1;
  let pnl = round2(positionSize * (resolved.exitPrice - entryPrice) * sign);

  // BUGFIX (аудит 2026-09-13, "спред учтён в калибровке, но не в балансе"),
  // адаптировано под резолв по уровням: applySpreadToOutcome() в
  // decision/apply-spread.ts переразмечает исход в калибровке, когда
  // реальное движение цены не превышает спред — то есть находится в
  // пределах цены исполнения и не является настоящим направленным
  // движением. Это по-прежнему актуально ТОЛЬКО для исхода 'timeout':
  // выход там происходит по случайной цене закрытия горизонта, которая
  // действительно может оказаться в пределах спреда от входа. Для
  // 'stop_loss'/'take_profit' это неприменимо — оба уровня уже построены с
  // запасом buffer×ATR поверх спреда самой геометрией паттерна (Фаза 0'),
  // и трактовать реальное касание уровня как "тай" из-за спреда означало
  // бы обесценить весь резолв по уровням. Полноценный учёт спреда по
  // бид/аск на входе/выходе — Фаза 6 (apply-spread.ts), это временный,
  // консервативный частный случай для timeout.
  if (resolved.exitReason === 'timeout') {
    const move = Math.abs(resolved.exitPrice - entryPrice);
    const isFlat = trade.spread != null && trade.spread > 0 && move <= trade.spread;
    if (isFlat) pnl = 0;
  }

  const balanceAfter = round2(trade.stake + pnl);

  // Стадия мартингейла управляется ТИПОМ исхода (win/loss/timeout), а не
  // знаком/размером pnl: при позиционной модели timeout может дать сколь
  // угодно малый положительный или отрицательный pnl в зависимости от
  // того, где горизонт застал цену — это не то же самое, что "чистая"
  // победа/поражение по геометрии паттерна, и не должно двигать лестницу
  // мартингейла (та же роль, которую раньше играл 'tie').
  let newMartingale: InstrumentMartingaleState;
  let seriesReset: 'win' | 'loss_final_stage' | null = null;

  if (resolved.outcome === 'timeout') {
    newMartingale = { ...currentState };
  } else if (resolved.outcome === 'win') {
    newMartingale = { stage: 0, halted: false };
    seriesReset = 'win';
  } else {
    if (!martingaleEnabled) {
      // Мартингейл выключен: сделка закрыта в убыток, но стадия НЕ
      // повышается — следующая ставка на этот инструмент остаётся равна
      // stage0Amount (без удвоения/повышения по стадиям).
      newMartingale = { stage: 0, halted: false };
    } else if (trade.stage >= 3) {
      newMartingale = { stage: 0, halted: false };
      seriesReset = 'loss_final_stage';
    } else {
      newMartingale = { stage: (trade.stage + 1) as Stage, halted: false };
    }
  }

  return { resolved, pnl, balanceAfter, newMartingale, seriesReset };
}

// Резолв по закрытым свечам — тонкая обёртка над applyResolvedOutcome().
// Возвращает null, если горизонт ещё не исчерпан и ни один уровень не
// задет (сделка остаётся открытой).
function resolveTrade(
  trade: DemoTrade,
  candlesAfterEntry: Candle[],
  currentState: InstrumentMartingaleState,
  martingaleEnabled: boolean,
): ResolveTradeResult | null {
  const resolvable: ResolvableSignal = {
    id: trade.signalId,
    direction: trade.direction,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
  };
  const resolved = resolveOutcomeByLevels(resolvable, candlesAfterEntry, trade.maxHorizonBars);
  if (!resolved) return null;
  return applyResolvedOutcome(trade, resolved, currentState, martingaleEnabled);
}

export const useDemoAccountStore = create<DemoAccountState>()(
  persist(
    (set, get) => ({
      balance: DEFAULT_BALANCE,
      stage0Amount: DEFAULT_STAGE0_AMOUNT,
      stageAmounts: DEFAULT_STAGE_AMOUNTS,
      profitPercent: DEFAULT_PROFIT_PERCENT,
      autoTradeEnabled: true,
      // Refactor variant A, Фаза 4: "мартингейл — explicitly помеченный
      // legacy-режим, выключен по умолчанию" (промт, Фаза 4). Это значение
      // применяется только к ДЕЙСТВИТЕЛЬНО новым установкам (нет
      // сохранённого localStorage вообще) — существующие пользователи,
      // ранее сохранившие martingaleEnabled (в любом значении, включая
      // унаследованный true из миграции version<6 ниже), не переключаются
      // этой правкой без их ведома. См. migrateDemoAccountState — миграция
      // намеренно НЕ трогает уже сохранённое значение поля.
      martingaleEnabled: false,
      martingale: {},
      openTrades: {},
      history: [],
      currentLossStreak: 0,

      openTrade: (signal, knownOpenPrice) => {
        const state = get();
        const key = instrumentKey(signal.symbolId, signal.timeframe);
        if (state.martingale[key]?.halted === true) return;

        if (!state.autoTradeEnabled) return;
        if (state.openTrades[signal.id]) return;

        // Аудит, п.2: без этой проверки по инструменту может быть открыто
        // несколько параллельных сделок на один и тот же symbolId:timeframe
        // (например, пока предыдущая сделка "зависла" orphan'ом и ждёт
        // resolveFromHistory — см. resolveFromHistory ниже). Параллельные
        // сделки на одной стадии мартингейла резолвятся вразнобой и создают
        // впечатление, что стадии 2/3 "пропускаются", а прибыль зачисляется
        // пачкой через несколько сделок. Гарантируем: на инструмент — не
        // больше одной открытой сделки одновременно.
        const hasOpenTradeForInstrument = Object.values(state.openTrades).some(
          (t) => t.symbolId === signal.symbolId && t.timeframe === signal.timeframe,
        );
        if (hasOpenTradeForInstrument) return;

        const currentStage: Stage = state.martingale[key]?.stage ?? 0;
        const desiredStake = getStageStake(currentStage, state.stage0Amount, state.stageAmounts);

        if (state.balance < desiredStake) {
          set({
            martingale: {
              ...state.martingale,
              [key]: { stage: 0, halted: true },
            },
          });
          return;
        }

        const tfSeconds = TIMEFRAME_SECONDS[signal.timeframe];
        const newCandleTime = signal.time + tfSeconds;
        const trade: DemoTrade = {
          signalId: signal.id,
          stake: desiredStake,
          profitPercent: state.profitPercent,
          direction: signal.direction,
          openedAt: Date.now(),
          entryPrice: knownOpenPrice ?? null,
          fallbackEntryPrice: signal.entryPrice,
          spread: signal.spread,
          // Фаза 4: уровни и горизонт с самого сигнала — тот же
          // barsToResolve, который signal-builder.ts уже проставил
          // паттерн-специфичным (Фаза 2), а не глобальной константой.
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          maxHorizonBars: signal.barsToResolve > 0 ? signal.barsToResolve : 1,
          expiryAt: (newCandleTime + tfSeconds) * 1000,
          symbolId: signal.symbolId,
          timeframe: signal.timeframe,
          candleTime: newCandleTime,
          stage: currentStage,
          stakeConfigAtOpen: {
            stage0Amount: state.stage0Amount,
            stageAmounts: state.stageAmounts,
          },
        };
        set({
          balance: round2(state.balance - desiredStake),
          openTrades: { ...state.openTrades, [signal.id]: trade },
        });
      },

      confirmEntryPrice: (symbolId, timeframe, candleTime, openPrice) => {
        const state = get();
        let changed = false;
        const openTrades = { ...state.openTrades };
        for (const [id, trade] of Object.entries(openTrades)) {
          if (
            trade.symbolId === symbolId &&
            trade.timeframe === timeframe &&
            trade.candleTime === candleTime &&
            trade.entryPrice === null
          ) {
            openTrades[id] = { ...trade, entryPrice: openPrice };
            changed = true;
          }
        }
        if (changed) set({ openTrades });
      },
      // Refactor variant A, Фаза 4: резолвится КАЖДАЯ открытая сделка на
      // инструменте на каждое закрытие свечи (candles — вся загруженная
      // история символа/таймфрейма), а не только те, чей expiryAt уже
      // прошёл — resolveOutcomeByLevels сам решает, исчерпан ли горизонт
      // конкретной сделки (см. resolve-by-levels.ts). expiryAt в DemoTrade
      // остаётся только для UI-таймера (CandleTimer.tsx), в резолве больше
      // не участвует.
      checkExpiries: (candles, nowMs, symbolId, timeframe) => {
        const state = get();
        const openForInstrument = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe)
          .sort((a, b) => a.candleTime - b.candleTime);

        if (openForInstrument.length === 0) return;

        let newBalance = state.balance;
        const newMartingale = { ...state.martingale };
        const remainingTrades = { ...state.openTrades };
        const newEntries: DemoTradeHistoryEntry[] = [];
        // АУДИТ 2026-09-13: серия обновляется в том же хронологическом
        // порядке, в котором сделки уже отсортированы выше (по candleTime).
        let newLossStreak = state.currentLossStreak;

        for (const trade of openForInstrument) {
          const candlesAfterEntry = getCandlesAfterSignal(candles, trade.candleTime);
          const key = instrumentKey(trade.symbolId, trade.timeframe);
          const currentState: InstrumentMartingaleState = newMartingale[key] ?? { stage: 0, halted: false };
          const result = resolveTrade(trade, candlesAfterEntry, currentState, state.martingaleEnabled);
          if (!result) continue; // горизонт ещё не исчерпан — сделка остаётся открытой

          newBalance = round2(newBalance + result.balanceAfter);
          newMartingale[key] = result.newMartingale;
          // 'timeout' (не задет ни один уровень за весь горизонт) намеренно
          // не двигает серию — как и раньше "тай", ни продолжает, ни
          // обрывает её.
          if (result.resolved.outcome === 'win') newLossStreak = nextLossStreak(newLossStreak, 'win');
          else if (result.resolved.outcome === 'loss') newLossStreak = nextLossStreak(newLossStreak, 'loss');

          delete remainingTrades[trade.signalId];
          // Аудит (синхронизация с демо-счётом): выставляем исход сигнала
          // синхронно, в том же проходе, что и сам результат сделки —
          // "ИСТОРИЯ СИГНАЛОВ" и винрейт в StatusBar обновляются в тот же
          // кадр, без задержек, и всегда 1:1 совпадают с тем, что видно
          // здесь же в "Последние сделки". resolved.outcome уже ровно то
          // значение SignalOutcome ('win'/'loss'/'timeout'), которое
          // resolveOutcomeByLevels определил по факту касания уровня — не
          // реконструируется из знака pnl.
          syncSignalOutcome(trade.signalId, result.resolved.outcome);
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.resolved.outcome === 'timeout' ? 'tie' : result.resolved.outcome,
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: nowMs,
            symbolId: trade.symbolId,
            timeframe: trade.timeframe,
            stage: trade.stage,
            seriesReset: result.seriesReset,
            exitPrice: result.resolved.exitPrice,
            exitReason: result.resolved.exitReason,
            barsHeld: result.resolved.barsHeld,
            ambiguousIntrabarTouch: result.resolved.ambiguousIntrabarTouch,
          });
        }

        if (newEntries.length === 0) return;

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          martingale: newMartingale,
          openTrades: remainingTrades,
          history: newHistory,
          currentLossStreak: newLossStreak,
        });
        useAnalyticsStore.getState().recomputeStats();
      },

      // Refactor variant A, Фаза 3/4: тиковая проверка текущей
      // формирующейся свечи, аналог tick-check в live-движке. Резолвит
      // сделку РАНЬШЕ закрытия свечи, если stopLoss/takeProfit уже задеты
      // по факту котировки — иначе баланс демо-счёта отставал бы от
      // реального исполнения на весь остаток текущей свечи. Использует ту
      // же applyResolvedOutcome(), что и checkExpiries()/
      // resolveFromHistory() — единая формула pnl/стадии независимо от
      // того, КАК был получен resolved-исход.
      checkTickLevel: (tick, symbolId, timeframe) => {
        const state = get();
        const openForInstrument = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe && t.entryPrice !== null);

        if (openForInstrument.length === 0) return;

        let newBalance = state.balance;
        const newMartingale = { ...state.martingale };
        const remainingTrades = { ...state.openTrades };
        const newEntries: DemoTradeHistoryEntry[] = [];
        let newLossStreak = state.currentLossStreak;
        const nowMs = Date.now();

        for (const trade of openForInstrument) {
          const resolvable: ResolvableSignal = {
            id: trade.signalId,
            direction: trade.direction,
            stopLoss: trade.stopLoss,
            takeProfit: trade.takeProfit,
          };
          const resolved = resolveOutcomeByTick(resolvable, tick);
          if (!resolved) continue;

          const key = instrumentKey(trade.symbolId, trade.timeframe);
          const currentState: InstrumentMartingaleState = newMartingale[key] ?? { stage: 0, halted: false };
          const result = applyResolvedOutcome(trade, resolved, currentState, state.martingaleEnabled);

          newBalance = round2(newBalance + result.balanceAfter);
          newMartingale[key] = result.newMartingale;
          // resolveOutcomeByTick никогда не возвращает 'timeout' (у тика
          // нет понятия исчерпанного горизонта) — только win/loss.
          if (result.resolved.outcome === 'win') newLossStreak = nextLossStreak(newLossStreak, 'win');
          else newLossStreak = nextLossStreak(newLossStreak, 'loss');

          delete remainingTrades[trade.signalId];
          syncSignalOutcome(trade.signalId, result.resolved.outcome);
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.resolved.outcome === 'timeout' ? 'tie' : result.resolved.outcome,
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: nowMs,
            symbolId: trade.symbolId,
            timeframe: trade.timeframe,
            stage: trade.stage,
            seriesReset: result.seriesReset,
            exitPrice: result.resolved.exitPrice,
            exitReason: result.resolved.exitReason,
            barsHeld: result.resolved.barsHeld,
            ambiguousIntrabarTouch: result.resolved.ambiguousIntrabarTouch,
          });
        }

        if (newEntries.length === 0) return;

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          martingale: newMartingale,
          openTrades: remainingTrades,
          history: newHistory,
          currentLossStreak: newLossStreak,
        });
        useAnalyticsStore.getState().recomputeStats();
      },

      resolveFromHistory: (symbolId, timeframe, candles) => {
        const state = get();
        const orphans = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe);

        if (orphans.length === 0) return;
        if (candles.length === 0) return;

        const earliestLoadedTime = candles[0].time;

        let newBalance = state.balance;
        const newMartingale = { ...state.martingale };
        const remainingTrades = { ...state.openTrades };
        const newEntries: DemoTradeHistoryEntry[] = [];
        // АУДИТ 2026-09-13: та же серия, что и в checkExpiries() — этот путь
        // резолвит "осиротевшие" сделки (см. комментарий про orphan-сделки
        // ниже), в том же порядке, в котором `orphans` обрабатывается для
        // newBalance/newMartingale.
        let newLossStreak = state.currentLossStreak;
        const nowMs = Date.now();

        for (const trade of orphans) {
          // БАГ (расхождение "сигнал должен быть в прибыли" vs демо-счёт в
          // минусе несколько сделок подряд): orphan-сделки попадают сюда,
          // когда живой поток свечей не доставил событие "новая свеча" для
          // ИМЕННО candleTime этой сделки, пока она была открыта — вкладка
          // была свёрнута/выгружена браузером, произошёл reload или
          // reconnect/resync (см. комментарии в handleCandle/pre-close.ts).
          // В этом случае trade.entryPrice так и остаётся null. Реальная
          // цена открытия свечи входа при этом уже есть в загруженной
          // истории (entryCandle.open) — подтверждаем её отсюда, если она
          // ещё не была подтверждена вживую (confirmEntryPrice). Если даже
          // этой свечи нет в загруженном окне (candleTime раньше самой
          // старой загруженной свечи) — используем trade.fallbackEntryPrice
          // (см. его собственный докблок в DemoTrade), как и раньше.
          const entryCandle = candles.find((c) => c.time === trade.candleTime);
          // Временный разрыв (gap): entryPrice ещё не подтверждена вживую,
          // сама свеча входа не найдена, но она НЕ старше загруженного
          // окна — то есть данные для неё в принципе должны быть, просто
          // ещё не долетели/не догружены. В этом случае НЕ резолвим на
          // trade.fallbackEntryPrice (устаревшая цена сигнала — см. докблок
          // ниже про исходный баг), а ждём следующего вызова с более полной
          // историей — ровно так же вело себя решение до этого рефакторинга.
          if (trade.entryPrice === null && !entryCandle && trade.candleTime >= earliestLoadedTime) {
            continue;
          }
          const resolutionType: 'normal' | 'fallback' =
            entryCandle ? 'normal' : trade.candleTime < earliestLoadedTime ? 'fallback' : 'normal';
          const resolvedTrade: DemoTrade =
            trade.entryPrice === null && entryCandle
              ? { ...trade, entryPrice: entryCandle.open }
              : trade;

          // Refactor variant A, Фаза 4: раньше здесь искалась РОВНО одна
          // "свеча истечения" на фиксированном оффсете от входа — единственно
          // возможная модель для close-vs-entry резолва. Резолв по уровням
          // (resolveOutcomeByLevels) сам решает, на какой из candlesAfterEntry
          // сделка резолвится (первое касание уровня ИЛИ исчерпание
          // maxHorizonBars) — так что нужен весь доступный после входа
          // диапазон, а не одна конкретная свеча. Если candlesAfterEntry
          // недостаточно, чтобы резолв состоялся (сделка младше своего
          // горизонта в загруженной истории), resolveTrade вернёт null, и
          // сделка останется orphan-ом до следующего вызова с большей
          // историей — это честнее, чем раньше принудительно резолвить её
          // по единственной, возможно ещё не наступившей свече.
          const candlesAfterEntry = getCandlesAfterSignal(candles, trade.candleTime);
          const key = instrumentKey(trade.symbolId, trade.timeframe);
          const currentState: InstrumentMartingaleState = newMartingale[key] ?? { stage: 0, halted: false };
          const result = resolveTrade(resolvedTrade, candlesAfterEntry, currentState, state.martingaleEnabled);
          if (!result) continue;

          const closedAtMs = candlesAfterEntry.length > 0
            ? (candlesAfterEntry[Math.min(result.resolved.barsHeld, candlesAfterEntry.length) - 1].time
                + TIMEFRAME_SECONDS[timeframe]) * 1000
            : nowMs;

          newBalance = round2(newBalance + result.balanceAfter);
          newMartingale[key] = result.newMartingale;
          if (result.resolved.outcome === 'win') newLossStreak = nextLossStreak(newLossStreak, 'win');
          else if (result.resolved.outcome === 'loss') newLossStreak = nextLossStreak(newLossStreak, 'loss');

          delete remainingTrades[trade.signalId];
          // См. комментарий в checkExpiries() — тот же синхронный источник
          // истины для orphan-сделок, доразрешаемых по загруженной истории.
          syncSignalOutcome(trade.signalId, result.resolved.outcome);
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.resolved.outcome === 'timeout' ? 'tie' : result.resolved.outcome,
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: closedAtMs,
            resolutionType,
            symbolId: trade.symbolId,
            timeframe: trade.timeframe,
            stage: trade.stage,
            seriesReset: result.seriesReset,
            exitPrice: result.resolved.exitPrice,
            exitReason: result.resolved.exitReason,
            barsHeld: result.resolved.barsHeld,
            ambiguousIntrabarTouch: result.resolved.ambiguousIntrabarTouch,
          });
        }

        if (newEntries.length === 0) return;

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          martingale: newMartingale,
          openTrades: remainingTrades,
          history: newHistory,
          currentLossStreak: newLossStreak,
        });
        useAnalyticsStore.getState().recomputeStats();
      },

      setStage0Amount: (amount) => set({ stage0Amount: Math.max(0, amount) }),
      setStageAmount: (stage, amount) =>
        set((s) => {
          const newAmounts = [...s.stageAmounts] as [number, number, number];
          newAmounts[stage - 1] = Math.max(0, amount);
          return { stageAmounts: newAmounts };
        }),
      setProfitPercent: (v) => set({ profitPercent: v }),
      setAutoTradeEnabled: (v) => set({ autoTradeEnabled: v }),
      setMartingaleEnabled: (v) => set({ martingaleEnabled: v }),
      setBalance: (v) =>
        set((s) => {
          if (v <= 0) return { balance: v };
          const newMartingale: Record<InstrumentKey, InstrumentMartingaleState> = {};
          for (const [key, ms] of Object.entries(s.martingale)) {
            newMartingale[key] = { stage: ms.stage, halted: false };
          }
          return { balance: v, martingale: newMartingale };
        }),
      resetAccount: () => {
        set((s) => ({
          balance: DEFAULT_BALANCE,
          stage0Amount: s.stage0Amount,
          stageAmounts: s.stageAmounts,
          profitPercent: s.profitPercent,
          autoTradeEnabled: s.autoTradeEnabled,
          martingaleEnabled: s.martingaleEnabled,
          martingale: {},
          openTrades: {},
          history: [],
          currentLossStreak: 0,
        }));
        // Bug fix: resetAccount() cleared the demo balance and trade
        // history but left the analytics signal history ("ИСТОРИЯ
        // СИГНАЛОВ") and StatusBar win/loss counters untouched. After a
        // reset the balance restarts at $1000 (fresh wins push it above),
        // while the stats still counted pre-reset signals — producing the
        // impossible-looking state of balance > $1000 with more losses
        // than wins. Clear both stores together so they stay consistent.
        useAnalyticsStore.getState().clearSignalHistory();
      },
    }),
    {
      name: 'demo-account',
      storage: createJSONStorage(() => localStorage),
      version: 7,
      migrate: migrateDemoAccountState,
    },
  ),
);

export function migrateDemoAccountState(
  persistedStateRaw: unknown,
  version: number,
): DemoAccountPersistedShape {
  const persistedState = persistedStateRaw as LegacyDemoAccountPersistedState;
  const s: LegacyDemoAccountPersistedState = { ...persistedState };
  if (version < 2) {
    delete s.consecutiveLosses;
    delete s.currentStake;
    s.martingale = s.martingale ?? {};
  }
  if (version < 3) {
    if (s.baseStake != null) {
      s.stage0Amount = s.baseStake;
    } else if (s.stage0Amount == null) {
      s.stage0Amount = DEFAULT_STAGE0_AMOUNT;
    }
    delete s.baseStake;
    if (!s.stagePercents) s.stagePercents = DEFAULT_STAGE_PERCENTS_LEGACY;
  }
  if (version < 4) {
    if (s.martingale) {
      for (const key of Object.keys(s.martingale)) {
        const entry = s.martingale[key];
        if (entry && entry.halted === undefined) {
          s.martingale[key] = { stage: entry.stage, halted: false };
        }
      }
    }
    // v3 data could still carry baseStake instead of stage0Amount
    if (s.stage0Amount == null && s.baseStake != null) {
      s.stage0Amount = s.baseStake;
      delete s.baseStake;
    }
  }
  if (version < 5) {
    // Stages 1-3 used to be stored as percentages of stage0Amount.
    // Convert them once into absolute dollar amounts so existing users
    // keep the same effective stake sizes after the upgrade.
    if (!s.stageAmounts) {
      const base = s.stage0Amount ?? DEFAULT_STAGE0_AMOUNT;
      const percents = s.stagePercents ?? DEFAULT_STAGE_PERCENTS_LEGACY;
      s.stageAmounts = [
        round2((base * percents[0]) / 100),
        round2((base * percents[1]) / 100),
        round2((base * percents[2]) / 100),
      ];
    }
    delete s.stagePercents;
  }
  if (version < 6) {
    // Новая настройка: по умолчанию мартингейл включён, чтобы поведение
    // для существующих пользователей не менялось после обновления.
    if (s.martingaleEnabled == null) {
      s.martingaleEnabled = true;
    }
  }
  if (version < 7) {
    // Refactor variant A, Фаза 4: DemoTrade получил обязательные поля
    // stopLoss/takeProfit/maxHorizonBars — у сделок, открытых ДО этого
    // обновления, их нет и взяться им неоткуда (это данные из сигнала на
    // момент открытия сделки, а не что-то реконструируемое задним числом).
    // Оставить такие сделки в openTrades означало бы, что resolveTrade()
    // упадёт на них при первом же вызове (обращение к trade.stopLoss даст
    // undefined). Честная миграция — не подделывать geometrию, а вернуть
    // ставку и закрыть сделку явным рефандом: баланс не должен "потерять"
    // деньги только из-за смены формата хранения демо-счёта.
    if (s.openTrades) {
      let refunded = 0;
      const survivingTrades: Record<string, unknown> = {};
      for (const [id, raw] of Object.entries(s.openTrades)) {
        const trade = raw as { stake?: number; stopLoss?: number };
        if (typeof trade.stopLoss === 'number') {
          survivingTrades[id] = raw;
        } else if (typeof trade.stake === 'number') {
          refunded += trade.stake;
        }
      }
      s.openTrades = survivingTrades;
      if (refunded > 0) {
        s.balance = round2((s.balance ?? DEFAULT_BALANCE) + refunded);
      }
    }
  }
  return {
    balance: s.balance ?? DEFAULT_BALANCE,
    stage0Amount: s.stage0Amount ?? DEFAULT_STAGE0_AMOUNT,
    stageAmounts: s.stageAmounts ?? DEFAULT_STAGE_AMOUNTS,
    profitPercent: s.profitPercent ?? DEFAULT_PROFIT_PERCENT,
    autoTradeEnabled: s.autoTradeEnabled ?? true,
    martingaleEnabled: s.martingaleEnabled ?? true,
    martingale: (s.martingale ?? {}) as Record<InstrumentKey, InstrumentMartingaleState>,
    openTrades: s.openTrades ?? {},
    history: s.history ?? [],
  };
}
