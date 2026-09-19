import type { Signal, SignalOutcome } from '@/types/domain';
import type { ExitReason } from './resolve-by-levels';

export interface SpreadAdjustedOutcome {
  outcome: SignalOutcome;
  spreadCostR: number;
  // Refactor variant A, Фаза 5 — синхронизация с Фазой 3/4. true, только
  // если exitReason === 'timeout' и фактическое движение цены на выходе
  // не превысило спред: та же самая (и единственная) точка, где спред
  // влияет на исход, что и в useDemoAccountStore.ts::applyResolvedOutcome
  // (см. её комментарий "BUGFIX ... адаптировано под резолв по уровням").
  // Не переименовывает и не понижает outcome — вызывающая сторона решает,
  // что делать с "плоским" таймаутом (демо-счёт зануляет pnl, бэктест
  // зануляет rMultiple), см. simulator.ts.
  isFlatTimeout: boolean;
}

// Refactor variant A, Фаза 5.
//
// История этого файла — раньше здесь стояло: applySpreadToOutcome(outcome,
// signal, spread, expiryClosePrice), сравнивавшее спред с движением цены
// на закрытии РОВНО следующей свечи (устаревший артефакт close-модели
// резолва) и по этому сравнению ПОНИЖАВШЕЕ 'win' до 'timeout'. Это было
// корректно только пока резолв в принципе игнорировал stopLoss/takeProfit
// (см. историю в outcome-scheduler.ts). Сейчас 'win' означает, что цена
// реально коснулась takeProfit — уровня, который вся Фаза 0' строит с
// запасом buffer×ATR поверх спреда, — трактовать такое касание как
// "спред съел движение" больше не имеет смысла (тот же аргумент, что и в
// useDemoAccountStore.ts: "оба уровня уже построены с запасом... и
// трактовать реальное касание уровня как тай означало бы обесценить весь
// резолв по уровням").
//
// Единственный случай, где спред всё ещё содержателен — 'timeout':
// сделка вышла по цене закрытия горизонта, которая МОЖЕТ оказаться внутри
// спреда от входа (то есть не была настоящим направленным движением).
// Функция сама не понижает outcome (он и так уже 'timeout' — резолв по
// уровням не возвращает 'win'/'loss' с exitReason='timeout'), а только
// сообщает вызывающей стороне, что этот конкретный timeout — "плоский",
// чтобы pnl/rMultiple можно было честно занулить вместо того, чтобы
// приписывать сделке случайный шум как доходность/убыток.
//
// Полноценный учёт спреда по бид/аск на входе/выходе для 'take_profit'/
// 'stop_loss' — отдельная, ещё не сделанная часть Фазы 6
// (decision/spread-estimate.ts используется как один общий bid/ask прокси
// уже везде, где резолв происходит по тику — см. resolveOutcomeByTick).
export function applySpreadToOutcome(
  resolved: { outcome: SignalOutcome; exitPrice: number; exitReason: ExitReason },
  signal: Pick<Signal, 'entryPrice'>,
  spread: number,
): SpreadAdjustedOutcome {
  const move = Math.abs(resolved.exitPrice - signal.entryPrice);
  const spreadCostR = move > 0 ? spread / move : 0;
  const isFlatTimeout = resolved.exitReason === 'timeout' && spread > 0 && move <= spread;

  return { outcome: resolved.outcome, spreadCostR, isFlatTimeout };
}
