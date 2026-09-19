import type { Candle, Signal, SignalOutcome } from '@/types/domain';
import { resolveOutcomeByLevels, type ExitReason } from './resolve-by-levels';

export interface ResolvedOutcome {
  signalId: string;
  outcome: SignalOutcome;
  // Refactor variant A, Фаза 3: резолв теперь знает, ПОЧЕМУ и ПО КАКОЙ
  // цене сделка закрылась — эти поля нужны демо-счёту (Фаза 4, позиционный
  // P&L считается от exitPrice) и миграции БД (Фаза 6: exit_price,
  // exit_reason, bars_held, ambiguous_intrabar_touch). Опциональны, чтобы
  // не ломать существующие места, собирающие ResolvedOutcome вручную
  // (тесты, старые записи).
  exitPrice?: number;
  exitReason?: ExitReason;
  barsHeld?: number;
  ambiguousIntrabarTouch?: boolean;
}

// Refactor variant A ("честная форекс-логика"), Фаза 3.
//
// История этого файла — два последовательных разворота, важно не откатить
// его обратно по ошибке:
//   1. Изначально здесь проверялось касание stopLoss/takeProfit на
//      протяжении barsToResolve свечей.
//   2. Предыдущий аудит СВЁЛ это к модели демо-счёта (цена закрытия ровно
//      следующей свечи против entryPrice, без участия stopLoss/takeProfit)
//      — потому что демо-счёт (useDemoAccountStore::resolveTrade) работал
//      именно так, и две модели давали разные исходы для одного signal.id.
//      Расхождение починили, но "вниз" — к бинарно-опционной модели.
//   3. Теперь (вариант А) обе стороны сводятся "вверх" — к резолву по
//      касанию уровней, единому для live и бэктеста
//      (resolve-by-levels.ts). Демо-счёт переводится на ту же функцию в
//      Фазе 4. НЕ возвращать close-следующей-свечи: это снова разведёт
//      резолв с геометрией SL/TP, которую считают все 33 паттерна
//      (Фаза 0').
export function resolveOutcome(
  signal: Signal,
  candlesAfterSignal: Candle[],
): ResolvedOutcome | null {
  if (signal.outcome !== 'pending') return null;
  if (candlesAfterSignal.length === 0) return null;

  // Горизонт берётся с самого сигнала: он паттерн-специфичен и проставлен
  // в signal-builder.ts через maxHorizonBarsForPattern() (Фаза 2), а не
  // является глобальной константой. Защита от нуля/мусора в старых
  // записях — иначе resolveOutcomeByLevels вернёт null навсегда и сигнал
  // залипнет в pending-очереди.
  const horizon = signal.barsToResolve > 0 ? signal.barsToResolve : 1;

  const resolved = resolveOutcomeByLevels(signal, candlesAfterSignal, horizon);
  if (!resolved) return null;

  return {
    signalId: resolved.signalId,
    outcome: resolved.outcome,
    exitPrice: resolved.exitPrice,
    exitReason: resolved.exitReason,
    barsHeld: resolved.barsHeld,
    ambiguousIntrabarTouch: resolved.ambiguousIntrabarTouch,
  };
}

export function getCandlesAfterSignal(
  allCandles: Candle[],
  signalTime: number,
): Candle[] {
  const after: Candle[] = [];
  for (const c of allCandles) {
    if (c.time > signalTime) after.push(c);
  }
  return after;
}

export interface PendingSignal {
  signal: Signal;
  barsElapsed: number;
}

export class OutcomeScheduler {
  private pending: PendingSignal[] = [];

  schedule(signal: Signal): void {
    if (signal.outcome !== 'pending') return;
    // Дедуп по id: schedule() реально вызывается для одного и того же
    // сигнала (один и тот же candleTime → один и тот же id, см.
    // generateSignalId) из двух разных мест — pre-close (maybeTriggerPreClose)
    // и "подстраховки" в maybeEvaluateSignal при isClosed === true — это
    // осознанный fallback-путь (см. комментарий в useTickStore.ts).
    // Без этой проверки оба вызова кладут в `pending` ДВЕ отдельные записи
    // с одинаковым signal.id; когда исход наступает, onCandleClosed()
    // резолвит и вызывает onResolve() ОБА раза для одного и того же
    // сигнала — это удваивает обучающие сэмплы калибровки
    // (eng.recordOutcome/triggerRetrain) и лишние обновления БД, реально
    // искажая ту самую статистику, на которую жалуется пользователь.
    //
    // ВАЖНО: если сигнал уже в очереди, ОБНОВЛЯЕМ его, а не пропускаем —
    // pre-close мог положить tradeOpened: false (сделка не открылась из-за
    // guard'а "одна сделка на инструмент"), а позже, при реальном закрытии
    // свечи, maybeEvaluateSignal открывает сделку и вызывает schedule() с
    // tradeOpened: true. Без обновления в очереди остаётся устаревший
    // tradeOpened: false, и maybeResolveOutcomes позже перезапишет
    // корректный исход от useDemoAccountStore своим собственным
    // (неправильным) — рассинхрон "Последние сделки" vs "История сигналов".
    const existingIdx = this.pending.findIndex((p) => p.signal.id === signal.id);
    if (existingIdx >= 0) {
      this.pending[existingIdx] = { signal, barsElapsed: this.pending[existingIdx].barsElapsed };
      return;
    }
    this.pending.push({ signal, barsElapsed: 0 });
  }

  onCandleClosed(
    allCandles: Candle[],
    onResolve: (resolved: ResolvedOutcome, signal: Signal) => void,
  ): void {
    if (this.pending.length === 0) return;
    const stillPending: PendingSignal[] = [];

    for (const p of this.pending) {
      const candlesAfter = getCandlesAfterSignal(allCandles, p.signal.time);
      const resolved = resolveOutcome(p.signal, candlesAfter);
      if (resolved) {
        onResolve(resolved, p.signal);
      } else {
        stillPending.push({ ...p, barsElapsed: candlesAfter.length });
      }
    }

    this.pending = stillPending;
  }

  clear(): void {
    this.pending = [];
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  getPendingList(): PendingSignal[] {
    return this.pending;
  }
}
