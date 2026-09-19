// РЕФАКТОРИНГ (бинарные опционы, Фаза 0, п.2): раньше называлось
// recommendedExpiry() и возвращало секунды, которые отображались на
// SignalCard как "время экспирации" — хотя фактический резолв сигнала
// (outcome-scheduler.ts / useDemoAccountStore.ts) всегда использовал ровно
// 1 бар и recommendedExpiry туда вообще не попадал (см. Signal.expiryBars —
// единственный параметр, реально управляющий резолвом). Эта функция теперь
// явно диагностическая: грубая оценка «сколько баров может занять
// разворачивание сетапа» по волатильности/режиму, в барах (не в секундах) —
// не путается по названию с реальной экспирацией.
export function estimatedPatternMaturityBars(
  atr: number,
  entryPrice: number,
  isRangeWithWeakTrend: boolean = false,
): number {
  if (atr <= 0 || entryPrice <= 0) return 1;
  const volatilityPct = atr / entryPrice;
  const baseBars = volatilityPct < 0.005 ? 3 : volatilityPct < 0.01 ? 2 : 1;
  return isRangeWithWeakTrend ? baseBars + 1 : baseBars;
}
