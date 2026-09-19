import type { Candle, Signal } from '@/types/domain';

// Refactor variant A ("честная форекс-логика"), Фаза 1.
//
// До этого модуля в кодовой базе существовали ДВА независимых определения
// исхода сделки для одного и того же signal.id:
//   1. Паттерны (trade-levels.ts) считают stopLoss/takeProfit как уровни
//      многобаровой сделки — подразумевая, что исход определяется тем,
//      какой из уровней будет задет ПЕРВЫМ.
//   2. outcome-scheduler.ts::resolveOutcome() / useDemoAccountStore.ts::
//      resolveTrade() резолвили исход по цене ЗАКРЫТИЯ ровно следующей
//      свечи — полностью игнорируя stopLoss/takeProfit.
// Расхождение этих двух моделей — задокументированная причина несовпадения
// "Последние сделки" (демо-счёт) vs "История сигналов" (аналитика).
//
// resolveOutcomeByLevels() — единственный источник истины для обеих
// сторон: идёт по свечам после сигнала и проверяет high/low (не close)
// против stopLoss/takeProfit, останавливаясь на первом баре, где задет
// хотя бы один уровень.
export type ExitReason = 'take_profit' | 'stop_loss' | 'timeout';

export interface ResolvedOutcomeByLevels {
  signalId: string;
  outcome: 'win' | 'loss' | 'timeout';
  exitPrice: number;
  exitReason: ExitReason;
  // Число свечей ПОСЛЕ сигнальной, включая ту, на которой сделка
  // резолвилась (1 = задето/истекло на первой же следующей свече).
  barsHeld: number;
  // true — на одной и той же свече задеты ОБА уровня (stopLoss И
  // takeProfit) и порядок касания внутри бара неизвестен (нет
  // тикового/M1-разложения). Консервативная политика — see below.
  ambiguousIntrabarTouch: boolean;
}

// Минимальный набор полей Signal, которые реально нужны резолву — не весь
// Signal, чтобы модуль было легко переиспользовать и в бэктесте (где нет
// живого Signal целиком, только его SL/TP/направление) и в live-движке.
export type ResolvableSignal = Pick<Signal, 'id' | 'direction' | 'stopLoss' | 'takeProfit'>;

/**
 * Резолвит исход сигнала по касанию stopLoss/takeProfit (high/low каждой
 * последующей свечи), а не по цене закрытия.
 *
 * @param signal              Сигнал (нужны только id/direction/stopLoss/takeProfit).
 * @param candlesAfterSignal  Свечи СТРОГО после времени сигнала, в
 *                            хронологическом порядке (см. getCandlesAfterSignal
 *                            в outcome-scheduler.ts — тот же контракт).
 * @param maxHorizonBars      Максимальное число свечей удержания. Если ни
 *                            один уровень не задет в пределах горизонта —
 *                            исход 'timeout', выход по close последней
 *                            свечи горизонта.
 * @returns null, если сигналу ещё рано резолвиться (уровни не задеты И
 *          горизонт ещё не исчерпан — свечей пока просто недостаточно).
 *          Как только один из уровней задет ИЛИ горизонт исчерпан —
 *          возвращает финальный результат.
 */
export function resolveOutcomeByLevels(
  signal: ResolvableSignal,
  candlesAfterSignal: Candle[],
  maxHorizonBars: number,
): ResolvedOutcomeByLevels | null {
  // Не должно происходить при осмысленном maxHorizonBars (>=1), но
  // защищаемся от вырожденного вызова явно, а не падаем на
  // horizonCandles[-1] в ветке timeout ниже.
  if (maxHorizonBars <= 0) return null;

  const isBuy = signal.direction === 'buy';
  const horizonCandles = candlesAfterSignal.slice(0, maxHorizonBars);

  for (let i = 0; i < horizonCandles.length; i++) {
    const candle = horizonCandles[i];
    const barsHeld = i + 1;

    // >= / <= (не строгое >/<): касание уровня РОВНО в моменте TP/SL уже
    // означает исполнение ордера на бирже — это не "почти задето".
    const hitTakeProfit = isBuy
      ? candle.high >= signal.takeProfit
      : candle.low <= signal.takeProfit;
    const hitStopLoss = isBuy
      ? candle.low <= signal.stopLoss
      : candle.high >= signal.stopLoss;

    if (hitTakeProfit && hitStopLoss) {
      // Intrabar-неопределённость: в пределах одной свечи задеты оба
      // уровня, а порядок касания (что было раньше — SL или TP) неизвестен
      // без тикового/младшего таймфрейма разложения этой свечи.
      // Консервативная политика (см. промт "Вариант А", Фаза 1): считать
      // stop_loss — не позволяем оптимистичному предположению ("наверное,
      // сначала пошли в прибыль") искусственно завышать winRate. Помечаем
      // ambiguousIntrabarTouch=true для последующего QA/разметки в БД
      // (Фаза 6 — колонка ambiguous_intrabar_touch).
      return {
        signalId: signal.id,
        outcome: 'loss',
        exitPrice: signal.stopLoss,
        exitReason: 'stop_loss',
        barsHeld,
        ambiguousIntrabarTouch: true,
      };
    }

    if (hitStopLoss) {
      return {
        signalId: signal.id,
        outcome: 'loss',
        exitPrice: signal.stopLoss,
        exitReason: 'stop_loss',
        barsHeld,
        ambiguousIntrabarTouch: false,
      };
    }

    if (hitTakeProfit) {
      return {
        signalId: signal.id,
        outcome: 'win',
        exitPrice: signal.takeProfit,
        exitReason: 'take_profit',
        barsHeld,
        ambiguousIntrabarTouch: false,
      };
    }
  }

  // Горизонт ещё не исчерпан (свечей после сигнала пока меньше, чем
  // maxHorizonBars) и ни один уровень не задет — сигнал остаётся pending,
  // резолвить пока рано.
  if (candlesAfterSignal.length < maxHorizonBars) {
    return null;
  }

  // Горизонт исчерпан, ни SL, ни TP не были задеты за maxHorizonBars
  // свечей — timeout. Выход по цене закрытия последней свечи горизонта
  // (а не по entryPrice и не по stopLoss/takeProfit — сделка реально была
  // открыта всё это время по рыночной цене).
  const lastHorizonCandle = horizonCandles[horizonCandles.length - 1];
  return {
    signalId: signal.id,
    outcome: 'timeout',
    exitPrice: lastHorizonCandle.close,
    exitReason: 'timeout',
    barsHeld: horizonCandles.length,
    ambiguousIntrabarTouch: false,
  };
}

/**
 * Refactor variant A, Фаза 3 — проверка ТЕКУЩЕЙ ФОРМИРУЮЩЕЙСЯ свечи по
 * живому тиковому потоку, а не по её (ещё неполному) OHLC.
 *
 * Зачем отдельная функция: resolveOutcomeByLevels() работает по ЗАКРЫТЫМ
 * свечам — их high/low окончательны. У формирующейся свечи high/low
 * дописываются на каждом тике, поэтому опрос её OHLC пропустил бы
 * касание уровня, случившееся и откатившееся внутри текущей минуты (на M1
 * это основной сценарий срабатывания стопа). Тик же даёт фактическую цену,
 * по которой ордер был бы исполнен прямо сейчас.
 *
 * Политика intrabar-неопределённости здесь НЕ нужна: один тик — одна цена
 * в один момент времени, а stopLoss и takeProfit всегда по разные стороны
 * от entry, поэтому задеть оба одним тиком нельзя. Если тик всё же
 * удовлетворяет обоим условиям — это признак испорченных уровней (SL и TP
 * перепутаны или совпали), и функция консервативно отдаёт stop_loss,
 * помечая случай тем же ambiguousIntrabarTouch для QA.
 *
 * @param signal Сигнал (нужны только id/direction/stopLoss/takeProfit).
 * @param tick   Текущий тик.
 * @param barsAlreadyElapsed Сколько ЗАКРЫТЫХ свечей уже прошло после
 *               сигнала — нужно только для barsHeld (формирующаяся свеча
 *               считается ещё одним, незавершённым баром удержания).
 * @returns null, если этим тиком ни один уровень не задет.
 */
export function resolveOutcomeByTick(
  signal: ResolvableSignal,
  tick: { price: number; bid?: number; ask?: number },
  barsAlreadyElapsed: number = 0,
): ResolvedOutcomeByLevels | null {
  const isBuy = signal.direction === 'buy';

  // Цена закрытия позиции — та сторона спреда, по которой реально
  // выходим: buy закрывается продажей по bid, sell — покупкой по ask.
  // Сознательно НЕ tick.price, когда бид/аск известны: иначе уровни
  // срабатывали бы по середине спреда, а исполнение происходило бы хуже —
  // та же систематическая переоценка winRate, которую Фаза 6 чинит на
  // стороне входа (apply-spread.ts).
  const exitQuote = isBuy ? (tick.bid ?? tick.price) : (tick.ask ?? tick.price);

  const hitTakeProfit = isBuy
    ? exitQuote >= signal.takeProfit
    : exitQuote <= signal.takeProfit;
  const hitStopLoss = isBuy
    ? exitQuote <= signal.stopLoss
    : exitQuote >= signal.stopLoss;

  if (!hitTakeProfit && !hitStopLoss) return null;

  const barsHeld = barsAlreadyElapsed + 1;

  if (hitStopLoss) {
    return {
      signalId: signal.id,
      outcome: 'loss',
      exitPrice: signal.stopLoss,
      exitReason: 'stop_loss',
      barsHeld,
      ambiguousIntrabarTouch: hitTakeProfit,
    };
  }

  return {
    signalId: signal.id,
    outcome: 'win',
    exitPrice: signal.takeProfit,
    exitReason: 'take_profit',
    barsHeld,
    ambiguousIntrabarTouch: false,
  };
}
