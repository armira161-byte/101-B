# Пре-существующая ошибка сборки: `CalibrationResult` (expiryBars/accuracy)

Дата: 2026-09-19. Найдено при проверке лога сборки bolt.new
(93 сбоя), локализовано до одного корневого расхождения типов, не
связанного с Refactor variant A — предшествует ему (ни один из 12 патчей
варианта А не трогал `src/compute/worker.ts`, `src/stores/
useAnalyticsStore.ts`, `src/ui/CalibrationPanel.tsx`).

## Причина

`export interface CalibrationResult` в `src/types/domain.ts` описывал
поля `atrMultiplier`/`stopLossPips`/`takeProfitPips`/`winRate` — форму
"ДО" того, как `src/compute/worker.ts::calibrateInWorker()` был переписан
(комментарий в самом файле: "РЕФАКТОРИНГ (бинарные опционы, Фаза 2/4)")
на модель "подбор `expiryBars`, максимизирующего `accuracy` направления".
Реализацию тогда поменяли полностью — `calibrateInWorker()`/
`backtestInWorker()`, `useAnalyticsStore.ts` (поля `expiryBacktestTrades`/
`expiryBacktestAccuracy`, подробно прокомментированные как "ATR-бэктест —
подбор `expiryBars` на истории"), `CalibrationPanel.tsx` (`result.
expiryBars`/`result.accuracy` в блоке результатов) — везде согласованно
используют `expiryBars`/`accuracy`. Не поменяли только сам интерфейс
`CalibrationResult` в `domain.ts` (и его неиспользуемую нигде zod-схему
`calibrationResultSchema`) — та единственная точка так и осталась
описывать старую, к тому моменту уже нигде фактически не читаемую форму.
Перед правкой проверено: ни одно место в кодовой базе не читает
`CalibrationResult.atrMultiplier`/`.stopLossPips`/`.takeProfitPips`/
`.winRate` — эти поля были мёртвыми.

## Исправление

`src/types/domain.ts`: `CalibrationResult` и `calibrationResultSchema`
приведены к форме, которую реально возвращает `calibrateInWorker()` и
ожидают её потребители:

```ts
export interface CalibrationResult {
  symbolId: string;
  timeframe: Timeframe;
  expiryBars: number;
  accuracy: number;
  totalTrades: number;
  calibratedAt: number;
}
```

`src/compute/worker.ts`, `src/stores/useAnalyticsStore.ts`,
`src/ui/CalibrationPanel.tsx` — не менялись, они уже были написаны под
эту форму.

`src/ui/ChartPanel.tsx`/`src/ui/SignalFeed.tsx` — при точечной проверке
прямых ссылок на `expiryBars`/`accuracy`/`CalibrationResult` не найдено;
если в них были диагностики сборки, они, вероятнее всего, были
каскадными от ошибки типа в `useAnalyticsStore.ts` (оба файла
импортируют этот стор) и должны исчезнуть вместе с этой правкой. Если
после пересборки в этих двух файлах останутся отдельные ошибки —
пришлите точный текст, это будет уже другая, не найденная сейчас причина.

## Важно

Правка проверена только ручным чтением и построчным трейсингом всех
потребителей `CalibrationResult` по всему репозиторию (`grep`) — реальный
`tsc`/`npm test` в этой сессии снова не запускались (нет сети). После
сборки в bolt.new пришлите лог, если сбоев останется больше нуля.
