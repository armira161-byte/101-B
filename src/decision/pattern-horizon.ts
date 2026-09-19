// Refactor variant A ("честная форекс-логика"), Фаза 2 — горизонт
// удержания (`maxHorizonBars`).
//
// До этого модуля горизонт был ОДНОЙ глобальной константой на весь продукт
// (BARS_TO_RESOLVE = 5 в useTickStore.ts, хардкод `barsToResolve: 5` в
// worker.ts, DEFAULT_BARS_TO_RESOLVE в engine.ts). Это искажает резолв в
// обе стороны:
//   - импульсные/двухсвечные паттерны (Engulfing, FVG-реакции) реализуются
//     за 1-3 бара — 5 баров даёт лишнее окно, в котором цена успевает
//     сходить против позиции и снять стоп уже ПОСЛЕ того, как тезис
//     паттерна фактически отработал;
//   - многобаровые паттерны (order-block-continuation, гармоники, Three
//     Methods, всё, что завязано на HTF-аппроксимацию) физически не
//     успевают дойти до цели за 5 баров и массово резолвятся в `timeout`,
//     что читается в отчётах как "паттерн не работает", хотя не работает
//     горизонт.
//
// Источник чисел — колонка "Гипотеза горизонта" из
// `pattern-audit-checklist.md` (сводка в конце файла: "вероятно короткие
// 1-3 бара" / "вероятно средние 3-10" / "вероятно длинные 10+"). Это
// ГИПОТЕЗЫ, а не измеренные оптимумы: финальные числа проставляются по
// результатам бэктест-сетки Фазы 5 (`maxHorizonBars ∈ {5,10,20,30,50}`
// отдельно по каждому паттерну), после чего эта таблица обновляется, а
// колонка "Backtest: лучший expiryBars" в чек-листе заполняется в
// значении "минимальный горизонт, на котором доля timeout не доминирует и
// winRate/R стабилизируются".
//
// ВАЖНО: модуль намеренно чистый (никаких импортов из stores/engine) и
// пока НЕ подключён к live-движку — подключение `resolvesAtTime`/
// `barsToResolve` в engine.ts/worker.ts/useTickStore.ts относится к Фазе 3
// и катится вместе с остальным деревом, а не отдельно.

export type PatternHorizonClass = 'short' | 'medium' | 'long' | 'unclassified';

// Стартовые значения горизонта по классу. Верхняя граница диапазона из
// чек-листа, а не середина: для резолва по касанию уровней (Фаза 1)
// слишком КОРОТКИЙ горизонт — это молчаливая потеря сделок, которые
// дошли бы до цели на следующем баре, тогда как слишком длинный лишь
// добавляет `timeout`-исходов, которые видны в отчёте и потому
// самокорректируются на Фазе 5.
export const HORIZON_BARS_BY_CLASS: Record<PatternHorizonClass, number> = {
  short: 3,
  medium: 10,
  long: 30,
  // Неклассифицированный паттерн получает средний горизонт, а не короткий:
  // занижение горизонта искажает исход тише, чем завышение (см. комментарий
  // выше). Совпадает с `medium` по значению намеренно — это не одно и то же
  // решение, и при обновлении по Фазе 5 они разъедутся.
  unclassified: 10,
};

// Классификация из сводки `pattern-audit-checklist.md`. Ключи — ровно те
// строки, что детекторы кладут в `PatternResult.name`.
const PATTERN_HORIZON_CLASS: Record<string, PatternHorizonClass> = {
  // ── Вероятно короткие (1-3 бара) ──────────────────────────────────────
  'impulse-breakout': 'short',
  'liquidity-sweep': 'short', // только setupType='continuation', см. horizonClassForPattern()
  'fvg-return': 'short',
  'fvg-rejection': 'short',
  'fvg-breaker-block': 'short',
  'consolidation-breakout': 'short',
  'inside-bar': 'short',
  'marubozu-bullish': 'short',
  'marubozu-bearish': 'short',
  'bullish-engulfing': 'short',
  'bearish-engulfing': 'short',
  'piercing-line': 'short',
  'dark-cloud-cover': 'short',

  // ── Вероятно средние (3-10 баров) ─────────────────────────────────────
  'liquidity-sweep-reaction': 'medium',
  'strong-order-block-reaction': 'medium',
  'order-block-breaker': 'medium',
  hammer: 'medium',
  'shooting-star': 'medium',
  'inverted-hammer': 'medium',
  'hanging-man': 'medium',
  'bullish-harami': 'medium',
  'bearish-harami': 'medium',
  'tweezer-bottom': 'medium',
  'tweezer-top': 'medium',
  'pin-bar': 'medium',
  'morning-star': 'medium',
  'evening-star': 'medium',
  'three-white-soldiers': 'medium',
  'three-black-crows': 'medium',

  // ── Вероятно длинные (10+ баров) ──────────────────────────────────────
  'order-block-continuation': 'long',
  'macd-deceleration-continuation': 'long',
  'harmonic-pattern': 'long',
  'mean-reversion': 'long',
  'rising-three-methods': 'long',
  'falling-three-methods': 'long',
  'abandoned-baby-bottom': 'long',
  'abandoned-baby-top': 'long',
  'order-block-nested': 'long',
  'fvg-nested': 'long',

  // Doji/Spinning Top сознательно отсутствуют: по чек-листу они не
  // подключены к TP/SL вообще (открытый продуктовый вопрос "являются ли
  // они самостоятельным направленным сигналом"), поэтому и горизонта у них
  // нет — попадут в 'unclassified', если когда-нибудь дойдут до резолва.
};

/**
 * Класс горизонта для паттерна. `setupType` нужен только для
 * `liquidity-sweep`: по чек-листу его continuation-сценарий относится к
 * коротким, а reversal-at-key-level (Wyckoff Spring/Upthrust) — к средним,
 * то есть один и тот же `PatternResult.name` даёт разный горизонт в
 * зависимости от сетапа.
 */
export function horizonClassForPattern(
  patternName: string | null | undefined,
  setupType?: 'continuation' | 'reversal-at-key-level',
): PatternHorizonClass {
  if (!patternName) return 'unclassified';

  if (patternName === 'liquidity-sweep' && setupType === 'reversal-at-key-level') {
    return 'medium';
  }

  return PATTERN_HORIZON_CLASS[patternName] ?? 'unclassified';
}

/**
 * Паттерн-специфичный горизонт удержания в барах — то, что передаётся
 * третьим аргументом в `resolveOutcomeByLevels()` (см. resolve-by-levels.ts).
 *
 * @param patternName Имя паттерна из `PatternResult.name`.
 * @param setupType   Сетап (нужен только для `liquidity-sweep`).
 * @returns Число баров > 0.
 */
export function maxHorizonBarsForPattern(
  patternName: string | null | undefined,
  setupType?: 'continuation' | 'reversal-at-key-level',
): number {
  return HORIZON_BARS_BY_CLASS[horizonClassForPattern(patternName, setupType)];
}

// Сетка горизонтов для пер-паттерновой калибровки на Фазе 5 (бэктест
// прогоняется по каждому значению отдельно для каждого паттерна, результат
// заполняет колонку "Backtest: лучший expiryBars" в чек-листе).
export const HORIZON_BACKTEST_GRID: readonly number[] = [5, 10, 20, 30, 50];
