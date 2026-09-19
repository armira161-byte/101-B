# pattern-audit-checklist.md — репозиторий `project-bolt-forex-tpsl` (вариант А)

## Как этот файл оказался неверным и почему он теперь такой

До 2026-09-19 по этому пути лежал документ, который сам себя описывал как
чек-лист **варианта Б** (`project-bolt-binary-options`, горизонт для
бинарных опционов — колонка `expiryBars`/`accuracy`), а не чек-лист
**варианта А** (этот репозиторий, `project-bolt-forex-tpsl`, геометрия
SL/TP) — при этом весь код в этом репозитории (19 файлов на момент этой
правки) ссылается на `pattern-audit-checklist.md` именно как на источник
геометрии SL/TP. Ошибка тянется из исходных материалов, с которых
начинался рефакторинг варианта А в этом репозитории — файл с верным именем,
но содержимым другого репозитория, попал в комплект по невнимательности при
самой первой сборке материалов и был скопирован как есть, без сверки
содержания с заголовком. Обнаружено и исправлено при углублённом аудите
качества рефакторинга 2026-09-19. Старое содержимое (оно самоценно для
репозитория варианта Б, не выбрасывается) сохранено рядом как
`pattern-audit-checklist-variant-B-mistakenly-included.md`.

Эта версия построена не по памяти и не заново с нуля, а прямым построчным
аудитом уже написанного кода: `src/decision/signal-builder.ts` (цепочка
`const levels = ... ? computeXxxTradeLevels(...) : ...`), `src/decision/
trade-levels.ts` (сами функции геометрии) и детекторы в
`src/compute/patterns/*.ts` — на момент этой правки таблица ниже отражает
реальное состояние кода, не план. Источник обоснования геометрии — по-прежнему
`sltp-geometry-source-variant-A.md` (не менялся, содержание верно, сверен
построчно при этой правке).

## Таблица — все 41 значение `PatternName`

Обозначения колонки «Статус»: **✅ own** — есть выделенная
`computeXxxTradeLevels()`, реализующая структурную геометрию именно этого
паттерна (не просто использующая общий ATR-фолбэк под другим именем).
**⚪ excluded** — паттерн намеренно не подключён к структурному TP/SL
(нет направленного тезиса, см. `sltp-geometry-source-variant-A.md`, §5) —
это не пробел, а продуктовое решение.

| № | Паттерн (`PatternName`) | Файл детектора | Стоп | Цель | Функция в `trade-levels.ts` | Статус |
|---|---|---|---|---|---|---|
| 1 | `impulse-breakout` | `impulse-breakout.ts` | за экстремумом пробойной свечи | ATR×2 (фикс.) | `computeBreakoutTradeLevels` | ✅ own |
| 2 | `liquidity-sweep-reaction` | `liquidity-sweep-reaction.ts` | за экстремумом свипнутого бара | ближайшая противоположная зона (`smartMoney`), иначе ATR×2 | `computeLiquiditySweepTradeLevels` | ✅ own |
| 3 | `liquidity-sweep` (`setupType='continuation'`) | `liquidity-sweep.ts` | за экстремумом свипнутого бара | ближайшая противоположная зона (`smartMoney`), иначе ATR×2 | `computeLiquiditySweepBaseTradeLevels` | ✅ own |
| 4 | `liquidity-sweep` (`setupType='reversal-at-key-level'`, = Wyckoff Spring/Upthrust) | `liquidity-sweep.ts` | за экстремумом свипнутого бара | противоположная граница локального Trading Range (`rangeHigh`/`rangeLow`), иначе ATR×2 | `computeLiquiditySweepBaseTradeLevels` | ✅ own |
| 5 | `order-block-breaker` | `order-block-breaker.ts` | за хвостом свечи снятия ликвидности (`breaker.time`/`ob.endTime`), НЕ за экстремумом самого breaker-блока | ближайшая противоположная зона, иначе ATR×2 | `computeOrderBlockBreakerTradeLevels` | ✅ own |
| 6 | `strong-order-block-reaction` | `strong-order-block-reaction.ts` | за дальней границей реагирующего блока | ближайшая противоположная зона, иначе ATR×2 | `computeStrongOrderBlockReactionTradeLevels` | ✅ own |
| 7 | `macd-deceleration-continuation` | `macd-deceleration-continuation.ts` | за экстремумом свечи-паузы | ближайшая противоположная зона, иначе ATR×2 | `computeMacdDecelerationTradeLevels` | ✅ own |
| 8 | `fvg-return` | `fvg-return.ts` | за экстремумом средней свечи FVG-формации | ближайшая противоположная зона, иначе ATR×2 | `computeFvgTradeLevels` | ✅ own |
| 9 | `fvg-rejection` | `fvg-rejection.ts` | за границей FVG-зоны | ближайшая противоположная зона, иначе ATR×2 | `computeFvgTradeLevels` | ✅ own |
| 10 | `fvg-breaker-block` | `fvg-breaker-block.ts` | за экстремумом инвертированной зоны (IFVG) | ближайшая противоположная зона, иначе ATR×2 | `computeFvgTradeLevels` | ✅ own |
| 11 | `fvg-nested` | `fvg-nested.ts` | за границей вложенной M1-зоны | ближняя граница содержащей HTF-зоны, иначе ATR×2 | `computeFvgTradeLevels` | ✅ own (внутрипроектная эвристика геометрии контейнера, не отдельная внешняя методология — см. источник §2) |
| 12 | `order-block-nested` | `order-block-nested.ts` | за границей вложенного M1 OB | ближняя граница содержащей HTF-зоны, иначе ATR×2 | `computeOrderBlockNestedTradeLevels` | ✅ own (та же оговорка, что и `fvg-nested`) |
| 13 | `order-block-continuation` | `order-block-continuation.ts` | ATR-based (общий) | `targetZone` от `findTargetZone()`, если даёт R:R ≥ 1.5, иначе ATR×2 | `computeOrderBlockContinuationTradeLevels` | ✅ own |
| 14 | `harmonic-pattern` (Gartley/Bat) | `harmonic-pattern.ts` | за точкой X (~1.13 XA) | Fib-проекция CD-ноги (61.8% отката к C) | `computeHarmonicTradeLevels` | ✅ own |
| 14b | `harmonic-pattern` (Butterfly/Crab) | `harmonic-pattern.ts` | за точкой D (1.27/1.618 XA) | то же | `computeHarmonicTradeLevels` | ✅ own |
| 14c | `harmonic-pattern` (AB=CD) | `harmonic-pattern.ts` | за точкой D (своей точки X-инвалидации нет) | то же | `computeHarmonicTradeLevels` | ✅ own |
| 15 | `consolidation-breakout` | `consolidation-breakout.ts` | за противоположной границей диапазона сжатия | measured move (высота диапазона от точки пробоя), иначе ATR×2 | `computeConsolidationBreakoutTradeLevels` | ✅ own (добавлено 2026-09-19 — паттерн уже был классифицирован в `pattern-horizon.ts`, но молча использовал ATR×2-фолбэк до этой правки) |
| 16 | `inside-bar` | `inside-bar.ts` | за противоположной границей материнской свечи | measured move (высота mother от точки пробоя), иначе ATR×2 | `computeInsideBarTradeLevels` | ✅ own (добавлено 2026-09-19, та же история, что и `consolidation-breakout`) |
| 17 | `mean-reversion` | `mean-reversion.ts` | за экстремумом бара выхода за полосу Боллинджера | средняя полоса Боллинджера (буквальный смысл названия), иначе ATR×2 | `computeMeanReversionTradeLevels` | ✅ own (добавлено 2026-09-19, та же история) |
| 18–38 | 21 классический свечной паттерн: `hammer`, `shooting-star`, `pin-bar`, `bullish-engulfing`, `bearish-engulfing`, `bullish-harami`, `bearish-harami`, `morning-star`, `evening-star`, `inverted-hammer`, `hanging-man`, `marubozu-bullish`, `marubozu-bearish`, `piercing-line`, `dark-cloud-cover`, `tweezer-bottom`, `tweezer-top`, `three-white-soldiers`, `three-black-crows`, `abandoned-baby-bottom`, `abandoned-baby-top` | `single.ts`/`double.ts`/`triple.ts`/`pin-bar.ts` | за экстремумом формации (1–3 свечи, зависит от паттерна) | ближайший структурный уровень или measured move (precomputed детектором), иначе ATR×2 | `computeCandlestickTradeLevels` (общая для всей группы — см. `sltp-geometry-source-variant-A.md` §5, расхождений с источниками не найдено) | ✅ own |
| 39 | `rising-three-methods` | `continuation.ts` | за минимумом 4-барной формации | measured move (высота импульсной свечи 1) | `computeThreeMethodsTradeLevels` | ✅ own (⚠️ статистически редкий паттерн на M1 — см. источник §5, малая выборка ожидаема в Фазе 5) |
| 40 | `falling-three-methods` | `continuation.ts` | за максимумом 4-барной формации | measured move | `computeThreeMethodsTradeLevels` | ✅ own (та же оговорка) |
| 41 | `doji` | `single.ts:detectDoji` | — | — | не подключён | ⚪ excluded (нерешительность, нет направленного тезиса — источники подтверждают без исключений, см. §5) |
| 42 | `spinning-top` | `single.ts:detectSpinningTop` | — | — | не подключён | ⚪ excluded (та же причина, что `doji`) |

## Проверка полноты (2026-09-19)

Сверено построчно: каждое из 41 значений `PatternName` (`src/types/
domain.ts`) либо явно матчится в цепочке `signal-builder.ts` (`const levels
= impulseBreakoutPattern ? ... : ... : consolidationBreakoutPattern ? ... :
... : estimateTradeLevels(...)`) на выделенную функцию, либо входит в
`CANDLESTICK_FAMILY_PATTERNS`, либо относится к `doji`/`spinning-top` (⚪
excluded намеренно). Ни один активный, торгуемый паттерн не остаётся на
generic-фолбэке `estimateTradeLevels()` по умолчанию — этот путь
используется только как последний `:`-случай цепочки, до 2026-09-19 туда
молча попадали `consolidation-breakout`/`inside-bar`/`mean-reversion`
(закрыто этой правкой, см. строки 15–17).

`estimateTradeLevels()` как таковая не удалена из `trade-levels.ts` (см.
промт варианта А, Фаза −1, п.2 — разрешено оставить как safety-net для
ещё не классифицированного паттерна), но по факту на 2026-09-19 не
достижима ни для одного активного детектора — это уже не «молчаливый
дефолт для четверти детекторов», как было на момент написания исходного
промта, а действительно последний рубеж защиты.
