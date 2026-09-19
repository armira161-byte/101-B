# Refactor variant A — Фаза 5 (завершение) + сопутствующие находки

Дата: 2026-09-17. Продолжение работы над промтом
`docs/refactor/refactor-variant-A-forex-tpsl.md` (Group-of-33-patterns SL/TP
refactor), по чек-листу `docs/audit/pattern-audit-checklist.md` и
геометрии `docs/audit/sltp-geometry-source-variant-A.md`.

К началу этой сессии Фазы 0''/0'/1/2/3/4 были собраны из 12
последовательных заходов (сохранены как история решений в самих
файлах — см. комментарии "Refactor variant A, Фаза N" по всему дереву).
Фаза 5 (бэктест) была начата, но её изменения не попали ни в один
из 12 патчей — эта сессия дописывает её с нуля по плану, оставленному
предыдущей сессией, и попутно чинит несколько независимых регрессий,
обнаруженных при сквозной проверке.

**Важно:** `npm run ci`/`npm run build`/тесты в этой сессии физически не
запускались — контейнер без доступа к сети, `node_modules` не
установлен. Все правки проверены построчным ревью плюс скриптовой
проверкой баланса скобок/кавычек по всем 246 `.ts`/`.tsx` файлам дерева
(строки/комментарии/шаблонные литералы вычитались перед подсчётом).
Перед использованием в проде обязательно прогнать `npm run ci` — это
первое, что стоит сделать после распаковки архива.

## Фаза 5 — доведена до конца

R-модель бэктеста полностью переведена с бинарно-опционного
`WIN_R = profitPercent/100, LOSS_R = -1` на реальную геометрию сделки —
тот же принцип, что Фаза 4 уже применила к демо-счёту.

- **`backtest/simulator.ts`** — горизонт резолва стал паттерн-специфичным
  (`signal.barsToResolve`, проставленный `maxHorizonBarsForPattern()` в
  Фазе 2/3) вместо одной глобальной константы на все паттерны; добавлено
  `horizonOverrideByPattern` для калибровочной сетки (см.
  `horizon-calibration.ts` ниже); добавлено поле `rMultiple` — реальная
  доходность сделки в R, посчитанная от `exitPrice/entryPrice/stopLoss`
  той же формулой, что и `useDemoAccountStore.ts`.
- **`src/decision/apply-spread.ts`** — переписан под резолв по уровням:
  спред больше никогда не понижает реальный `win`/`take_profit` (уровень
  уже построен с запасом buffer×ATR поверх спреда), а только помечает
  "плоский" (`isFlatTimeout`) уже-и-так-`timeout` — та же логика, что и в
  `useDemoAccountStore.ts::applyResolvedOutcome`.
- **`backtest/metrics.ts`** — `computeMetrics()` больше не принимает
  `profitPercent`; `averageR`/`profitFactor`/`maxDrawdownR` считаются от
  `rMultiple` каждой сделки. Добавлено поле `averageWinR` (средний R среди
  побед) — единственный содержательный вход для честной точки
  безубыточности.
- **`backtest/change-registry.ts`** — `computeForwardTestReport()` больше
  не принимает `profitPercent`; точка безубыточности форвард-теста
  (`breakevenWinRateFromAverageWinR`) выводится из `metrics.averageWinR`
  той же выборки (`p = 1/(averageWinR+1)`, т.к. loss всегда даёт
  `rMultiple === -1` в позиционной модели), а не из давно нерелевантной
  экономики демо-счёта. Добавлена запись `breakeven-position-model-aware`
  в `LOGIC_CHANGE_LOG`.
- **`backtest/report.ts`, `backtest/index.ts`, `backtest/harmonic-audit.ts`**
  — убраны все следы `--profit-percent`/`DEFAULT_PROFIT_PERCENT_FALLBACK`;
  консольный/markdown/JSON отчёт показывает `Average Win R` вместо
  фиктивного единого "Payout".
- **`backtest/horizon-calibration.ts`** (новый файл) — калибровочная
  сетка `{5, 10, 20, 30, 50}` по каждому реально встретившемуся в данных
  паттерну; печатает таблицу `winRate/timeoutRate/averageR/averageWinR`
  на каждом горизонте. Результат — вход для РУЧНОГО переноса числа в
  `HORIZON_BARS_BY_CLASS` и заполнения колонки "Backtest: лучший
  expiryBars" в чек-листе; сам скрипт ничего не переписывает.
- Тесты: `backtest/metrics.test.ts` (новый, прямое покрытие), `backtest/
  simulator.test.ts`, `backtest/change-registry.test.ts`, `backtest/
  backtest.test.ts`, `src/decision/apply-spread.test.ts` — обновлены/
  дописаны под новую модель.

## Побочные находки (не связаны с профит-моделью, но всплыли при ревью)

**0. (Найдено и исправлено при повторном аудите качества, тот же день.)
`signal.pattern?.name` вместо `signal.pattern` — реально ломало
`horizonOverrideByPattern`.** `Signal.pattern` — это уже готовая строка
(`PatternName | null`, см. `types/domain.ts` и
`signal-builder.ts: pattern: evidence.pattern?.name ?? null`), а не
объект с полем `.name` — тот объект (`evidence.pattern`, с `.name`/
`.setupType`) существует только ВНУТРИ `signal-builder.ts` и на `Signal`
наружу не попадает. Я перепутал эти два типа при первом написании
`backtest/simulator.ts`/`backtest/horizon-calibration.ts`: `signal.pattern
?.name` на строке всегда даёт `undefined` (у строк нет поля `.name`),
из-за чего:
- `simulator.ts`: `horizonOverrideByPattern` никогда ни на что не
  срабатывал — калибровочный оверрайд горизонта был молча нерабочим
  (хотя остальной резолв продолжал работать штатно на обычном
  `signal.barsToResolve`, так что existing тесты этого не ловили);
- `horizon-calibration.ts`: обнаружение паттернов всегда находило ноль
  паттернов — скрипт всегда завершался бы с "ни один паттерн не
  сработал", даже на данных, где паттернов было полно.

Исправлено на прямое `signal.pattern` в обоих файлах. Заодно поправлены
два оставшихся текстовых `/stake`-лейбла в `report.ts`/
`harmonic-audit.ts` (остальной вывод уже был переведён на `R`) и
перепутанные местами `stopLoss`/`takeProfit` в тестовой фикстуре
`trade-report.test.ts` — она единственная из ~13 пакетно исправленных
фикстур была с `direction: 'sell'`, а скрипт вставлял геометрию как для
`buy` (стоп ниже входа вместо выше).

**1. `src/stores/tick-store/outcomes.ts` (живой путь обучения калибровки).**
Всё ещё сравнивал спред с ценой закрытия РОВНО следующей свечи
(`candlesAfter[0]?.close`) — устаревший артефакт до перехода
`outcome-scheduler.ts` на резолв по уровням в Фазе 3. Переписан на
`resolved.exitPrice/exitReason`, той же функцией `applySpreadToOutcome()`,
что и бэктест/демо-счёт. Заодно исправлена рассинхронизированная с
`Signal` тестовая фикстура в `outcomes.test.ts` (см. п.3 ниже) — кандидаты
на резолв (`takeProfit`) пересчитаны так, чтобы сценарии по-прежнему
резолвились на первой же свече, как и предполагал исходный нарратив
тестов.

**2. `Signal.expiryBars` → `Signal.recommendedExpiry`/`barsToResolve`
(рассинхронизация, оставшаяся с Фазы 0'/1).** Где-то в Фазе 0'/1 варианта
А поле `Signal.expiryBars` было переименовано/расщеплено на
`barsToResolve` (реальный параметр резолва) и `recommendedExpiry`
(диагностическая оценка "зрелости" сетапа, бывшая
`estimatedPatternMaturityBars`) — но несколько живых потребителей об этом
не узнали:

- **`src/ui/SignalCard.tsx`** — карточка сигнала показывала `NaN`
  вместо срока экспирации (`signal.expiryBars` = `undefined`). Исправлено
  на `signal.barsToResolve` (комментарий в самом файле подтверждает: "тот
  же параметр, что использует резолв исхода").
- **`src/lib/trade-report.ts`** — постмортем-отчёт по сделке падал/
  показывал мусор на строке "Вход", и вдобавок текстуально описывал
  СТАРУЮ бинарно-опционную модель ("резолвится по цене закрытия через N
  баров, без SL/TP") — ровно то, что весь этот рефакторинг должен был
  заменить. Переписана строка "Вход": теперь показывает реальные `SL`/
  `TP`, горизонт резолва (`barsToResolve`) и диагностику
  (`recommendedExpiry`) — без утверждения "SL/TP не участвуют".
- **`src/lib/signal-persistence.ts`** — маппинг на Supabase-колонки
  (`expiry_bars`/`estimated_pattern_maturity_bars`) был написан под старые
  имена полей. Важно: DB-схема НЕ менялась (миграций в этой сессии нет) —
  колонки называются как раньше, поменялось только то, с каким полем
  `Signal` их сопоставляет клиент. `bars_to_resolve` (отдельная,
  уже существовавшая колонка) остаётся единственным источником
  `Signal.barsToResolve` при чтении; `expiry_bars` при записи теперь
  просто зеркалит то же значение (ради её `NOT NULL`), а при чтении не
  используется — чтобы не завести два конфликтующих источника одного
  поля (в первой версии этого фикса такой конфликт был и есть в истории
  правок этого файла — задваивание ключа `barsToResolve` в возвращаемом
  объекте, второе значение молча перекрывало первое; исправлено до
  сборки архива).
- **`src/ui/CalibrationPanel.tsx`** — строка `Stat label="Экспирация
  (баров)" value={result.expiryBars}` НЕ трогалась: это поле другого типа
  (`CalibrationResult` от ATR-бэктеста воркера, `src/compute/worker.ts`),
  у него `expiryBars` — легитимное, не переименованное поле, не связанное
  с `Signal`.
- Порядка 12 тестовых файлов (`useAnalyticsStore.test.ts`,
  `useTickStore.test.ts`, `SignalCard.test.tsx`, `CalibrationPanel.test.tsx`,
  `StatusBar.test.tsx`, `SignalFeed.test.tsx`,
  `PredictionAccuracyBadge.test.tsx`, `factor-analytics.test.ts`,
  `calibration-buckets.test.ts`, `trade-report.test.ts`,
  `threshold-calibration.test.ts`, `tick-store/shared.test.ts`,
  `signal-persistence.test.ts`) использовали ту же устаревшую фабрику
  `makeSignal()` (`expiryBars`/`estimatedPatternMaturityBars`, без
  `stopLoss`/`takeProfit` вовсе — ещё одна не связанная с этим
  рассинхронизация, оставшаяся, судя по всему, с ЕЩЁ более раннего,
  предшествующего варианту А, изменения схемы `Signal`). Приведены к
  актуальной форме — `stopLoss`/`takeProfit`/`recommendedExpiry`, по
  образцу уже исправленной в Фазе 3 фабрики в
  `src/decision/outcome-scheduler.test.ts`.

**3. `src/lib/trade-report.test.ts`** — тест `includes expiryBars and
estimatedPatternMaturityBars ... no SL/TP` буквально фиксировал старое,
уже неверное поведение. Переписан на проверку новой строки "Вход" (SL/TP
+ горизонт резолва).

## Сознательно НЕ сделано в этой сессии (осталось на будущее)

- **Фаза 6 (БД-миграции, UI).** Не начата. В частности,
  `src/ui/CalibrationPanel.tsx` продолжает вычислять точку безубыточности
  для живой калибровки паттернов из `useDemoAccountStore.profitPercent`
  (`breakevenWinRateFromProfitPercent`) — поле оставлено в публичном API
  демо-счёта намеренно (см. комментарий в `useDemoAccountStore.ts`), но
  с Фазы 4 больше не участвует в реальном расчёте pnl. Показываемая
  панелью точка безубыточности из-за этого не отражает настоящую,
  позиционную экономику. Правильный фикс — аналог того, что уже сделано
  для бэктеста в `change-registry.ts`: считать точку безубыточности из
  РЕАЛЬНОГО среднего R выигрышных демо-сделок (нужна либо агрегация в
  `useAnalyticsStore`, либо в самом демо-сторе) — отдельная, более
  крупная задача с продуктовыми решениями (за какой период усреднять,
  что показывать при отсутствии выигрышей и т.д.), не взята в эту сессию
  умышленно.
- **Фаза 7 (регрессия по всему чек-листу).** Не проводилась — нет сети
  для `npm run ci`/`npm test`. Обязательный первый шаг после распаковки.
- Открытые продуктовые вопросы из промта (судьба Doji/Spinning Top,
  legacy-тумблер мартингейла и т.п.) — не решались, статус тот же, что
  и до этой сессии.
