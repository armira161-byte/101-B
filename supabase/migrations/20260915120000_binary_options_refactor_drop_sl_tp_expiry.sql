/*
  # Binary options refactor — Фаза −1/0/1

  ВАЖНО (примечание добавлено 2026-09-19 при углублённом аудите, сама
  миграция ниже НЕ редактируется задним числом — история миграций
  неизменяема): эта миграция ссылается на таблицу `signals`, которой не
  существует — реальная таблица называется `trading_signals` (см.
  `20260804012847_create_trading_signals_tables.sql`). Если эта миграция
  когда-либо реально накатывалась на боевую БД, каждый из операторов ниже
  должен был упасть с ошибкой "relation \"signals\" does not exist" —
  то есть таблица `trading_signals`, скорее всего, НЕ получила ни одного
  из описанных ниже изменений: `stop_loss`/`take_profit`/
  `recommended_expiry` всё ещё NOT NULL без `expiry_bars`/
  `estimated_pattern_maturity_bars`. Кроме того, к моменту этой правки
  вариант А уже вернул `stop_loss`/`take_profit` как обязательные поля
  `Signal` на уровне приложения (`src/types/domain.ts`) — эта миграция
  описывает направление, полностью противоположное текущему коду.
  Корректирующая миграция, безопасная независимо от того, применилась эта
  миграция или нет: `20260919120000_fix_trading_signals_sl_tp_columns.sql`.
*/

/*
  # Binary options refactor — Фаза −1/0/1

  Приложение переведено на модель "честный бинарный опцион с фиксированной
  экспирацией": сделка не закрывается по касанию stop-loss/take-profit —
  только по цене закрытия ровно через `expiry_bars` баров после сигнала (см.
  src/decision/expiry.ts, src/decision/outcome-scheduler.ts).

  1. Изменения схемы
     - `stop_loss`, `take_profit` — удаляются полностью (DROP COLUMN, а не
       "просто перестать туда писать"). Уровни сделки при фиксированной
       экспирации не имеют смысла: сделка не резолвится по их касанию.
     - `recommended_expiry` (секунды, adaptive-оценка) — удаляется: раньше
       отображалась пользователю как "время экспирации", но реальный резолв
       её не использовал (подтверждённый баг рассинхронизации, Фаза 0).
     - `expiry_bars` (integer, NOT NULL DEFAULT 1) — добавляется: единственный
       параметр, реально управляющий резолвом. DEFAULT 1 сохраняет прежнее
       фактическое поведение (резолв всегда брал первую свечу после сигнала)
       для всех уже существующих строк.
     - `estimated_pattern_maturity_bars` (integer, NOT NULL DEFAULT 1) —
       добавляется: переименованная диагностика (бывший recommended_expiry),
       теперь в барах, явно НЕ путается с реальной экспирацией.

  2. Безопасность
     Существующие RLS-политики таблицы `signals` не завязаны на конкретные
     столбцы (row-level, не column-level) — не меняются.

  3. Обратная совместимость
     DEFAULT 1 на обеих новых колонках означает, что уже вставленные строки
     получают корректное значение без отдельного backfill: реальный резолв
     всех прошлых сигналов и так всегда происходил ровно на 1-м баре после
     сигнала (см. аудит Фазы 0), так что expiry_bars=1 для них исторически
     точен, а не просто безопасный дефолт.
*/

ALTER TABLE signals DROP COLUMN IF EXISTS stop_loss;
ALTER TABLE signals DROP COLUMN IF EXISTS take_profit;
ALTER TABLE signals DROP COLUMN IF EXISTS recommended_expiry;

ALTER TABLE signals ADD COLUMN IF NOT EXISTS expiry_bars integer NOT NULL DEFAULT 1;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS estimated_pattern_maturity_bars integer NOT NULL DEFAULT 1;
