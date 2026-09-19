# Источник геометрии SL/TP для варианта А — сверено с внешними источниками
### Обязательный входной документ для `pattern-audit-checklist.md` (Фаза 0' промта варианта А)

Каждое правило ниже — не мнение, а сверка с профильными источниками по конкретной методологии (ICT/SMC-ресурсы, Wyckoff-ресурсы, справочники по гармоникам, статистика Bulkowski по свечным паттернам, литература по ATR-стопам). Список источников — в конце документа. Там, где текущая реализация в коде (`trade-levels.ts`, детекторы паттернов) уже соответствует найденному правилу — отмечено «✅ подтверждено кодом». Там, где найденное правило **уточняет или исправляет** более раннюю (менее детальную) версию рекомендации из `pattern-audit-checklist.md` — отмечено «⚠️ уточнение».

---

## 1. Order Block / Breaker Block / Strong Order Block Reaction

**Стоп**: за дальней (противоположной входу) границей блока — для бычьего OB ниже его low, для медвежьего — выше его high, с небольшим буфером (источники расходятся в конкретных цифрах для разных рынков — от «нескольких пипсов» до 10–20 пипсов на форексе; в проекте это уже реализовано как `buffer × ATR` с дефолтом `buffer = 0.1`, что соответствует «небольшому буферу поверх структурного экстремума», а не самостоятельному ATR-стопу — расхождение с более широкими ATR-мультипликаторами 1.5–2×, которые в источниках применяются только при **отсутствии** структурного уровня, см. раздел 6).

**Цель**: ближайшая точка притяжения ликвидности (opposing swing high/low, непокрытый пул ликвидности, противоположный OB) — не фиксированный ATR×2.

**✅ подтверждено кодом** для `order-block-continuation.ts` (уже есть `computeOrderBlockContinuationTradeLevels`).

**⚠️ уточнение для `strong-order-block-reaction.ts`**: генерируемая функция `computeStrongOrderBlockReactionTradeLevels()` должна ставить стоп именно за экстремумом самого отбившего блока (`ob.low`/`ob.high` из `smartMoney.orderBlocks`), а не пересчитывать его заново из ATR — геометрия идентична обычному Order Block, разница только в силе реакции (уже учтена детектором отдельно, в геометрию TP/SL не входит).

**⚠️ уточнение для `order-block-breaker.ts`**: стоп-лосс breaker-блока — это **не** тот же уровень, что у обычного OB. Правило, подтверждённое несколькими источниками независимо: стоп ставится не «сразу за телом брейкера», а **за хвостом свечи, которая совершила снятие ликвидности** (тот самый стоп-хант, из-за которого блок стал breaker) — если цена вернётся и снимет именно этот хвост, институциональный тезис отменён. Технически: `stopLoss = sweepWick.low − buffer×ATR` (buy) / `sweepWick.high + buffer×ATR` (sell), где `sweepWick` — экстремум свечи снятия ликвидности, предшествующей формированию breaker, а не экстремум самого breaker-блока. Нужно проверить, отдаёт ли детектор `order-block-breaker.ts` этот sweep-экстремум наружу (в `PatternResult`) — если нет, это дополнительное поле нужно добавить перед написанием `computeOrderBlockBreakerTradeLevels()`.

---

## 2. Fair Value Gap (FVG) — return / rejection / breaker-block / nested

**Стоп**: за дальней границей самой FVG-зоны (не за хвостом входной свечи) — стоп ставится «beyond the gap boundaries»/«beyond the middle FVG candle» в терминах источников: конкретно — за экстремумом **средней свечи трёхсвечной FVG-формации** (той самой свечи, чей диапазон и образует зону).

**✅ подтверждено кодом**: моя более ранняя рекомендация для `fvg-rejection.ts` (`SL = fvg.bottom/fvg.top`) — верна по направлению, но формально это то же самое, что «экстремум средней свечи», раз FVG-зона по определению ограничена телом/тенями свечей 1 и 3 вокруг средней свечи 2 — оставить как есть, уточнить только в коде, что `fvg.bottom`/`fvg.top` должны совпадать с экстремумом свечи 2, а не с округлённой границей зоны.

**Цель**: следующая точка притяжения ликвидности (old high/low, противоположный FVG, structure point) — не глубина самой зоны.

**Для inverse/breaker-вариантов FVG** (`fvg-breaker-block.ts`): стоп — за экстремумом самой инвертированной зоны (IFVG high/low), это отдельное, более широкое понятие, чем экстремум исходной FVG до инверсии — подтверждает уже данную ранее рекомендацию «за breaker-блоком (role-inversion уровень)», уточнять не нужно.

**Для `fvg-nested.ts`, `order-block-nested.ts`**: специфика вложенности (M1-зона внутри HTF-approximation) не описана ни в одном профильном источнике как отдельная методология — это инженерное расширение проекта поверх стандартной ICT-геометрии, не классическая методология. Рекомендация раздела не меняется (стоп за границей вложенной M1-зоны, цель — ближняя граница HTF-зоны), но эта пара паттернов помечается как «внутрипроектная эвристика, не подтверждаемая внешним источником» — держать под повышенным вниманием при бэктесте (Фаза 5), не считать авторитетность геометрии равной остальным SMC/ICT-паттернам.

---

## 3. Liquidity Sweep — оба setupType, явная связь с Wyckoff Spring/Upthrust

Это важное уточнение к `liquidity-sweep.ts`/`liquidity-sweep-reaction.ts`, которого не было в предыдущей версии чек-листа: **`setupType === 'reversal-at-key-level'`** — это по методологии ровно Wyckoff Spring (для buy) / Upthrust (для sell), а `setupType === 'continuation'` — это в чистом виде ICT liquidity sweep continuation. У них **разная цель**, хотя стоп одинаков:

- **Стоп (оба setupType)**: за экстремумом самой свечи снятия ликвидности — `last.low − buffer×ATR` (buy) / `last.high + buffer×ATR` (sell). Подтверждено и ICT-, и Wyckoff-источниками независимо (у Wyckoff — «below the spring low» / «above the upthrust high», у ICT — «beyond the tail of the liquidity sweep»). Уже верно в предыдущей версии чек-листа, менять не нужно.
- **Цель при `reversal-at-key-level` (= Spring/Upthrust)**: ⚠️ уточнение — по Wyckoff-методологии цель не «ближайшая противоположная зона через smartMoney» (как было в предыдущей версии чек-листа), а **противоположная граница той же диапазонной структуры (Trading Range)**, в которой произошёл спринг/апthrust: для buy-спринга — верх диапазона накопления, минимум; для sell-апthrust — низ диапазона распределения. Это требует, чтобы детектор либо сам вычислял границы локального диапазона (recentHigh/recentLow за N баров до сигнала), либо получал их из уже существующей структурной логики (`structure`/`session-regime`, если там уже трекается недавний range). Если в коде нет уже готового способа определить границы диапазона — это отдельная, небольшая задача внутри Фазы 0', не просто переиспользование `smartMoney`.
- **Цель при `continuation`**: остаётся, как в предыдущей версии — ближайшая противоположная зона через `smartMoney` (это уже не Wyckoff-логика, а чистый ICT continuation, там цель — следующий liquidity draw, не границы диапазона).

---

## 4. Гармонические паттерны (Gartley/Bat/Butterfly/Crab/ABCD) — существенное уточнение

Предыдущая версия чек-листа трактовала весь `harmonic-pattern.ts` одним правилом «TP/SL по Fib-проекции». Внешние источники независимо подтверждают, что **правило стопа различается по двум подсемействам гармоник**, и это нужно явно проверить в текущей реализации `computeHarmonicTradeLevels()`:

- **«Внутренние» паттерны (точка D находится внутри диапазона XA — Gartley, Bat)**: стоп ставится **за точкой X** (обычно на уровне 1.13 расширения XA), а не просто «за точкой D» — потому что для этих паттернов именно пробой X инвалидирует всю структуру.
- **«Расширяющиеся» паттерны (точка D выходит за пределы X — Butterfly, Crab, Deep Crab)**: точка X пробивается по определению самого паттерна (это не инвалидация, а часть структуры), поэтому стоп ставится **за самой точкой D** (за теоретическим уровнем расширения — обычно 1.27 или 1.618 XA), а не за X.
- **AB=CD (без X/A/B/C/D-полного набора точек Gartley)**: паттерн проще, стоп по общей практике — за точкой D (аналогично Crab/Butterfly-логике, т.к. AB=CD не имеет отдельной точки X как якоря инвалидации).

**Действие**: перед тем как считать `computeHarmonicTradeLevels()` завершённой (эта функция помечена в Группе 1 чек-листа как «✅ own» — уже подключена), нужно явно проверить в её коде, различает ли она эти два случая по типу гармоники, или использует одну и ту же формулу для всех. Если использует одну — это не баг детекции (структура находится верно), но это методологическая неточность в геометрии стопа для Gartley/Bat (стоп окажется либо слишком широким, либо слишком узким относительно того, что реально инвалидирует паттерн) — доработать до начала Фазы 5 (бэктеста), иначе бэктест провалидирует геометрию, которая не соответствует канону, и результат будет некорректно интерпретирован как «паттерн плохо работает», хотя на самом деле плохо работает только стоп.

**Цель** — по всем подсемействам единообразно: ретрейсмент/расширение CD-ноги (обычно 38.2–61.8% отката к точке С или проекция к точке А) — подтверждено источниками, менять не нужно.

---

## 5. Классические японские свечи и Price Action (single/double/triple/pin-bar/continuation)

Внешняя проверка **подтвердила без существенных уточнений** геометрию, уже зафиксированную в предыдущей версии `pattern-audit-checklist.md` для всех 21 свечного паттерна и pin-bar: стоп — за экстремумом формации (1, 2 или 3 свечи, в зависимости от паттерна), цель — ближайший структурный уровень или measured move. Никаких расхождений с найденными источниками не обнаружено — единственное дополнение:

- **Rising/Falling Three Methods**: формула measured-move (`entry ± высота свечи-импульса 1`) подтверждена буквально (источник называет её «measure rule»/«measured move projection»). Но источник также прямо указывает, что это **статистически редкий паттерн** (десятки-сотни случаев на миллионы свечей в исходной выборке) и что фактическое достижение measured-move цели происходит меньше чем в половине случаев даже при подтверждённом продолжении тренда. **Важный вывод для Фазы 5 (бэктест)**: на M1-форекс/крипто-данных этот паттерн, скорее всего, будет давать очень маленькую выборку сигналов — заранее закладывать в бэктест-план, что для Rising/Falling Three Methods может не хватить статистической мощности за разумный период истории, и результат по этому паттерну нужно интерпретировать с поправкой на малую выборку, а не как окончательный вердикт.
- **Doji/Spinning Top**: внешние источники подтверждают прежний вывод — оба паттерна документируются как сигналы нерешительности/паузы, а не самостоятельного направленного движения; ни один найденный источник не даёт для них самостоятельного правила SL/TP как для направленного входа. Рекомендация не подключать их к TP/SL как отдельные сигналы остаётся в силе без изменений.

---

## 6. Буфер/ATR — сведение конвенций

Источники по волатильности (ATR-стопы) описывают **два разных употребления ATR**, которые нельзя путать:

1. **ATR как единственный источник дистанции стопа** (нет структурного уровня рядом) — здесь принятый в индустрии диапазон для внутридневной/M1-торговли — 1.5–2× ATR(14). Это соответствует тому, как сейчас работает `estimateTradeLevels()` (generic-фолбэк) в проекте.
2. **ATR как небольшой буфер поверх уже найденного структурного уровня** (OB/FVG/wick/breaker) — здесь источники называют существенно меньшие величины (единицы–десятки пипсов, не «полтора ATR») — то, что уже реализовано в проекте как `buffer × ATR` с дефолтом `0.1`.

**Вывод**: нынешний дефолт `buffer = 0.1` в `trade-levels.ts` **не нужно менять** — он соответствует конвенции №2 и корректен именно там, где есть структурный уровень (то есть везде, где Фаза 0' достраивает `computeXxxTradeLevels()` по геометрии из этого документа). Конвенция №1 (1.5–2× ATR) относится **только** к путям, которые после завершения Фазы 0' не должны остаться в системе как основные (см. промт варианта А, Фаза −1, п.2 — удаление `estimateTradeLevels()` как дефолтного пути после того, как все паттерны получат структурную геометрию).

---

## Сводка исправлений относительно предыдущей версии чек-листа

| Паттерн | Было | Стало (после сверки с источниками) |
|---|---|---|
| `order-block-breaker.ts` | стоп за экстремумом breaker-блока | стоп за хвостом свечи снятия ликвидности, предшествующей breaker (может не совпадать с экстремумом самого блока) |
| `liquidity-sweep.ts`, `setupType='reversal-at-key-level'` | цель — ближайшая противоположная зона через `smartMoney` | цель — противоположная граница локального Trading Range (методология Wyckoff Spring/Upthrust), нужна отдельная логика определения границ диапазона |
| `liquidity-sweep.ts`, `setupType='continuation'` | цель — ближайшая противоположная зона через `smartMoney` | без изменений — подтверждено |
| `harmonic-pattern.ts` | единая формула SL «за X/D» для всех гармоник | стоп различается по подсемейству: Gartley/Bat — за X (1.13 XA), Butterfly/Crab — за D (1.27/1.618 XA); нужно проверить, учитывает ли текущая `computeHarmonicTradeLevels()` эту развилку |
| `continuation.ts` (Rising/Falling Three Methods) | геометрия TP/SL | геометрия подтверждена без изменений, добавлен статистический риск малой выборки для интерпретации Фазы 5 |
| Остальные 17 свечных/pin-bar паттернов | геометрия из предыдущей версии чек-листа | подтверждена без изменений |
| `buffer = 0.1` в `trade-levels.ts` | не обсуждалось явно | подтверждено как корректная конвенция, менять не нужно |

---

## Источники

- ATAS: ICT Order Blocks & Breaker Blocks — https://atas.net/blog/what-are-ict-order-blocks-and-breaker-blocks-in-trading/
- Metals Mine: Understanding ICT Order Blocks — https://www.metalsmine.com/thread/1344362-understanding-ict-order-blocks-tflab
- LuxAlgo: ICT Concepts — Order Blocks Explained — https://www.luxalgo.com/blog/ict-trader-concepts-order-blocks-unpacked/
- The Inner Circle Traders: ICT Order Block Trading — https://www.theinnercircletraders.com/ict-order-block/
- Smart Money ICT: Stop Losses in ICT — https://smartmoneyict.com/stop-losses-in-ict/
- Trading Strategy Guides: ICT Order Block Guide — https://tradingstrategyguides.com/ict-order-block-complete-identification-and-trading-guide/
- FXNX: ICT Breaker Blocks — https://fxnx.com/en/blog/ict-breaker-blocks-master-art-trading-failed-order-blocks
- InnerCircleTrader.net: ICT Bullish Order Block — https://innercircletrader.net/tutorials/ict-bullish-order-block/
- InnerCircleTrader.net: ICT Order Block Explained — https://innercircletrader.net/tutorials/ict-order-block/
- InnerCircleTrader.net: ICT Inverse Fair Value Gap — https://innercircletrader.net/tutorials/ict-inversion-fair-value-gap/
- InnerCircleTrader.net: ICT Fair Value Gap — 6-Step Strategy — https://innercircletrader.net/tutorials/fair-value-gap-trading-strategy/
- InnerCircleTrader.net: ICT Implied Fair Value Gap — https://innercircletrader.net/tutorials/ict-implied-fair-value-gap-ifvg/
- TrendSpider: Fair Value Gap Trading Strategy — https://trendspider.com/learning-center/fair-value-gap-trading-strategy/
- ATAS: Fair Value Gap (FVG) Trading — https://atas.net/blog/fvg-trading-what-is-fair-value-gap-meaning-strategy/
- Funded Trading Plus: FVG Strategy — https://www.fundedtradingplus.com/propiq/ict-fair-value-gap-fvg-trading-strategy-smart-money-concepts-explained/
- b2broker: Wyckoff Distribution — https://b2broker.com/news/what-is-a-wyckoff-distribution-a-traders-guide-to-spotting-reversals/
- TradingView (frankieho_92): Wyckoff Method — Comprehensive Analysis — https://www.tradingview.com/script/Grzy0O68-Wyckoff-Method-Comprehensive-Analysis/
- The Chartist: Pattern Recognition — Trading Springs — https://www.thechartist.com.au/pattern-recognition-springs/
- TradingSim: Wyckoff Method Trading — https://www.tradingsim.com/blog/wyckoff-method-trading
- TradingView (FibAlgo): Wyckoff Spring & Upthrust — https://www.tradingview.com/script/H3zpGMiK-Wyckoff-Spring-Upthrust-FibAlgo/
- TradingWyckoff.com: Wyckoff Method 2026 — https://tradingwyckoff.com/en/wyckoff-method/
- TradingWyckoff.com: Wyckoff Spring & Shakeout — https://tradingwyckoff.com/en/spring-shakeout/
- WyckoffAnalytics.com: Wyckoff Method — https://www.wyckoffanalytics.com/wyckoff-method/
- JournalPlus: Wyckoff Method Trading Strategy Guide — https://journalplus.co/strategies/wyckoff-method-trading/
- CapMint: Harmonic Patterns Guide — https://www.capmint.com/learn/glossary/harmonic-patterns
- LuxAlgo Library: Gartley — https://www.luxalgo.com/library/concept/gartley/
- NAGA: Harmonic Patterns — https://naga.com/en/academy/harmonic-patterns-gartley-butterfly-bat-crab
- Equiti: Butterfly Pattern Trading — https://www.equiti.com/sc-en/news/trading-ideas/what-is-butterfly-pattern-trading/
- JournalPlus: Harmonic Pattern Trading Strategy Guide — https://journalplus.co/strategies/harmonic-pattern-trading/
- NSBroker: Harmonic Pattern Trading Strategy — https://nsbroker.com/en/investment-strategies/harmonic-pattern-trading-strategy
- The5ers: Gartley Butterfly Pattern — https://the5ers.com/gartley-butterfly-pattern/
- TradingForex: Harmonic Patterns — https://tradingforex.com/tdcpt_courses/mastering-technical-analysis/harmonic-patterns/
- FXNX: Mastering Harmonic Patterns — https://fxnx.com/en/blog/mastering-harmonic-patterns-surgical-forex-entries
- Strike.money: Hammer Candlestick Pattern — https://www.strike.money/technical-analysis/hammer-candlestick-pattern
- Strike.money: 23 Bullish Candlestick Patterns — https://www.strike.money/technical-analysis/bullish-candlestick-patterns
- TradingSim: 6 Best Bullish Candlestick Patterns — https://www.tradingsim.com/blog/6-best-bullish-candlestick-patterns
- IG International: 16 Candlestick Patterns — https://www.ig.com/en/trading-strategies/16-candlestick-patterns-every-trader-should-know-180615
- LuxAlgo: Hammer Pattern — https://www.luxalgo.com/blog/hammer-pattern-essential-candlestick-signal/
- WRTrading: 50 Accurate Candlestick Patterns — https://wrtrading.com/technical-analysis/charts/candlestick/pattern/
- WRTrading: Morning Star Candlestick Pattern — https://wrtrading.com/technical-analysis/charts/candlestick/pattern/morning-star/
- Acquire.fi: Rising Three Methods — https://www.acquire.fi/glossary/rising-three-methods-what-it-is-how-it-works
- Titan FX Research: Three Methods — https://research.titanfx.com/technical-analysis/candlestick-chart/rising-and-falling-three-methods
- MNCL Group: Rising Three Methods Guide — https://www.mnclgroup.com/rising-three-methods-candlestick-pattern-guide
- TradingMetrics Docs: Rising Three Methods — https://docs.tradingmetrics.com/en/technical-analysis/trading-patterns/continuation-patterns/special-patterns/rising-three-methods
- HowToTrade: Rising and Falling Three Methods — https://howtotrade.com/chart-patterns/rising-and-falling-three-methods/
- WRTrading: Rising Three Methods Pattern — https://wrtrading.com/technical-analysis/charts/candlestick/pattern/rising-three-methods/
- AlphaEx Capital: Rising Three Methods (Bulkowski measure rule) — https://www.alphaexcapital.com/forex/candlestick-patterns/rising-three-methods
- TradingView (es): Falling Three Methods — Bulkowski stats — https://es.tradingview.com/chart/BTCUSD/rAyxkv5e-BTC-potential-for-Falling-3-Methods-Daily
- LuxAlgo: How to Use ATR for Volatility-Based Stop-Losses — https://www.luxalgo.com/blog/how-to-use-atr-for-volatility-based-stop-losses/
- LuxAlgo: Average True Range — Dynamic Stop Loss Levels — https://www.luxalgo.com/blog/average-true-range-dynamic-stop-loss-levels/
- QuantVPS: ATR Stop Loss — https://www.quantvps.com/blog/atr-stop-loss
- QuantStock: ATR Position Size Calculator — https://quantstock.org/calculators/atr-position-size
- AlphaEx Capital: ATR Based Stop Loss — https://www.alphaexcapital.com/stocks/technical-analysis-for-stock-trading/trading-strategies-using-technical-analysis/atr-based-stop-loss
- Pomegra Learn Library: Volatility-Based Stops Using ATR — https://pomegra.io/learn/library/track-e-trading-risk/risk-management/chapter-03-stop-losses/atr-based-stops
- Audacity Capital: ATR Indicator Guide — https://audacity.capital/trading-guides/atr-indicator/
- Fazen Capital: ATR Indicator — Dynamic Stop Loss — https://fazencapital.com/learn/en/atr-indicator-stop-loss-position-sizing
