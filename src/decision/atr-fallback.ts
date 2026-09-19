import type { IndicatorSnapshot } from '@/types/domain';

// РЕФАКТОРИНГ (бинарные опционы, Фаза −1): раньше жили в trade-levels.ts
// вместе с computeTradeLevels()/computeBreakoutTradeLevels() и т.д. Эти две
// функции — не часть удалённого TP/SL-слоя: это чисто индикаторный фолбэк
// (когда ATR ещё не прогрелся/недоступен), нужный сигналу независимо от
// того, строится ли по нему структурный TP/SL (которого в этом приложении
// больше нет) — atrValue используется для gate'ов (spread gate, ADX/режим),
// не только для уровней сделки.
export function avgRangeFromSnapshot(
  candles: { high: number; low: number }[],
  period: number,
): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  let sum = 0;
  for (const c of slice) sum += c.high - c.low;
  return sum / slice.length;
}

export function fallbackAtr(snapshot: IndicatorSnapshot, candles: { high: number; low: number }[], period: number): number {
  if (snapshot.atr !== null && snapshot.atr > 0) return snapshot.atr;
  return avgRangeFromSnapshot(candles, period);
}
