/*
  # Fix trading_signals SL/TP columns (corrects a broken prior migration)

  ## Контекст находки (аудит 2026-09-19)

  `20260915120000_binary_options_refactor_drop_sl_tp_expiry.sql` ссылалась
  на несуществующую таблицу `signals` вместо `trading_signals` — при
  реальном накате она должна была упасть с ошибкой на первом же
  операторе. Из-за этого фактическое состояние `trading_signals` на любой
  конкретной базе неизвестно заранее: это может быть как исходная схема
  (`stop_loss`/`take_profit`/`recommended_expiry` NOT NULL, без
  `expiry_bars`/`estimated_pattern_maturity_bars`), так и — если кто-то
  вручную поправил имя таблицы при накате и всё же применил её — схема
  ПОСЛЕ той миграции (без `stop_loss`/`take_profit`, с `expiry_bars`/
  `estimated_pattern_maturity_bars`).

  Эта миграция написана так, чтобы безопасно и идемпотентно привести
  таблицу к ЕДИНОМУ корректному состоянию независимо от того, с какой из
  двух стартовых точек она применяется — а также при повторном запуске
  (все операторы либо `IF EXISTS`/`IF NOT EXISTS`, либо естественно
  идемпотентны).

  ## Целевое состояние (после этой миграции)

  Вариант А вернул `Signal.stopLoss`/`Signal.takeProfit` как обязательные
  поля на уровне приложения (реальная геометрия входа для 41 паттерна, см.
  `docs/audit/pattern-audit-checklist.md`) — таблица должна снова уметь их
  хранить. Колонки делаются NULLABLE (не NOT NULL, как в самой первой
  версии схемы): если эта миграция применяется к БД, где предыдущая
  (сломанная) миграция всё-таки успела выполниться и реальные историчные
  значения `stop_loss`/`take_profit` были физически удалены (DROP COLUMN),
  их нечем бэкофиллить — честнее оставить старые строки с NULL
  ("значение не сохранено"), чем подставлять придуманные числа.
  `src/lib/signal-persistence.ts` учитывает это и использует безопасный
  синтетический фолбэк только на ЧТЕНИИ старых NULL-строк — на запись
  новый код всегда получает настоящие значения от `Signal.stopLoss`/
  `Signal.takeProfit` (обязательные поля, гарантированы TypeScript).

  `expiry_bars`/`estimated_pattern_maturity_bars` — не трогаются, они уже
  использовались реальным кодом (`src/lib/signal-persistence.ts`) как
  legacy-зеркало `barsToResolve` и источник `recommendedExpiry`
  соответственно, вне зависимости от которого из двух состояний БД
  стартовала эта миграция; если их ещё нет — добавляются с тем же
  безопасным дефолтом, что и в исходной (сломанной) миграции.

  `recommended_expiry` (старое, adaptive-оценка в секундах) — не
  восстанавливается: код это поле больше нигде не читает и не пишет
  (заменено на `recommended_expiry`-семантику через
  `estimated_pattern_maturity_bars`, что само по себе легаси-именование
  колонки, но менять имя существующей колонки рискованнее, чем оставить
  как есть — см. `src/lib/signal-persistence.ts` для маппинга).

  ## Безопасность

  RLS-политики `trading_signals` — row-level, не привязаны к конкретным
  столбцам, не требуют изменений.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trading_signals' AND column_name = 'stop_loss'
  ) THEN
    ALTER TABLE trading_signals ADD COLUMN stop_loss double precision;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trading_signals' AND column_name = 'take_profit'
  ) THEN
    ALTER TABLE trading_signals ADD COLUMN take_profit double precision;
  END IF;
END $$;

-- Снимаем NOT NULL, если колонки дожили с исходной схемы (см. объяснение
-- нулабельности выше) — no-op, если колонки уже нулабельны (в т.ч. только
-- что добавленные ADD COLUMN без NOT NULL выше).
ALTER TABLE trading_signals ALTER COLUMN stop_loss DROP NOT NULL;
ALTER TABLE trading_signals ALTER COLUMN take_profit DROP NOT NULL;

ALTER TABLE trading_signals ADD COLUMN IF NOT EXISTS expiry_bars integer NOT NULL DEFAULT 1;
ALTER TABLE trading_signals ADD COLUMN IF NOT EXISTS estimated_pattern_maturity_bars integer NOT NULL DEFAULT 1;
