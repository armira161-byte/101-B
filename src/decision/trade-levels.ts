import type { IndicatorSnapshot } from '@/types/domain';

export interface TradeLevels {
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export function computeTradeLevels(
  entryPrice: number,
  atr: number,
  atrMultiplier: number,
  direction: 'buy' | 'sell',
): TradeLevels {
  const stopDistance = atr * atrMultiplier;
  const isBuy = direction === 'buy';
  return {
    entry: entryPrice,
    stopLoss: isBuy ? entryPrice - stopDistance : entryPrice + stopDistance,
    takeProfit: isBuy ? entryPrice + stopDistance * 2 : entryPrice - stopDistance * 2,
  };
}

// Shared by live trading and backtest. TP is always fixed at 2x the stop
// distance (see computeTradeLevels), so R:R is always exactly 2.0 by
// construction — there is no meaningful R:R threshold to gate on here.
// (There used to be a `riskRewardRatio(levels) < MIN_RR` check, but since
// R:R is always 2.0 for any stopDistance > 0, that condition could only
// ever be true when risk <= 0 — already covered by the atrValue <= 0 gate
// in signal-builder.ts. It was dead code that misleadingly suggested R:R
// was a configurable quality filter, so it was removed. If a real R:R
// filter is wanted, takeProfit needs to depend on something other than a
// hardcoded multiplier — e.g. nearby S/R or order-block levels.)
export function estimateTradeLevels(
  entryPrice: number,
  atr: number,
  atrMultiplier: number,
  direction: 'buy' | 'sell',
): TradeLevels {
  return computeTradeLevels(entryPrice, atr, atrMultiplier, direction);
}

// Structural stop/target for breakout-type strategies (currently
// impulse-breakout). The shared computeTradeLevels() above places the stop
// at an arbitrary atrMultiplier*ATR distance from entry — for a breakout
// that is methodologically backwards: the signal candle's body is already
// required to be >=1x ATR (>=1.2x when volume is unreliable, see
// impulse-breakout.ts), so at the userʼs minimum atrMultiplier (0.5) the
// stop sits *inside* the very candle that generated the signal, guaranteeing
// an almost immediate stop-out. A breakout stop belongs beyond the extreme
// of the breakout candle itself (the level that was just taken out), not at
// a fixed ATR distance from close.
export function computeBreakoutTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  breakoutCandleLow: number,
  breakoutCandleHigh: number,
  atrValue: number,
  buffer: number = 0.1,
): TradeLevels {
  const stopLoss =
    direction === 'buy'
      ? breakoutCandleLow - atrValue * buffer
      : breakoutCandleHigh + atrValue * buffer;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  return {
    entry: entryPrice,
    stopLoss,
    takeProfit:
      direction === 'buy'
        ? entryPrice + stopDistance * 2
        : entryPrice - stopDistance * 2,
  };
}

// Structural stop/target for liquidity-sweep-reaction (audit finding #6:
// previously this pattern used the shared computeTradeLevels()'s flat
// atrMultiplier*ATR stop with a fixed 2.0 R:R, which ignores the very
// structure the pattern already detected — the sweep bar's own extreme is
// the ICT-correct place for the stop, and the nearest opposite-side
// liquidity zone (OB/FVG) is the ICT-correct take-profit target, not an
// arbitrary multiple.
//
// - SL: buy -> sweepBarLow - buffer*ATR; sell -> sweepBarHigh + buffer*ATR.
//   If the actual sweep was shallower than atrMultiplier*ATR the old formula
//   would have made the stop wider than necessary for no reason; if the
//   sweep was deeper, the old stop could land *inside* the zone that was
//   just swept, getting stopped out by noise before the real move.
// - TP: the nearest opposite-side OB/FVG edge beyond entry (precomputed by
//   the detector via nearestOppositeZonePrice, since it already has
//   smartMoney in scope) — but only if that target clears the minimum R:R;
//   otherwise fall back to the shared 2x-stopDistance target, exactly like
//   computeBreakoutTradeLevels. See strategy doc §7-8 and audit finding #6.
export function computeLiquiditySweepTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  sweepBarLow: number,
  sweepBarHigh: number,
  nearestOppositeZone: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  const stopLoss =
    direction === 'buy'
      ? sweepBarLow - atrValue * buffer
      : sweepBarHigh + atrValue * buffer;
  const stopDistance = Math.abs(entryPrice - stopLoss);

  const fallbackTakeProfit =
    direction === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

  if (nearestOppositeZone !== null && stopDistance > 0) {
    const rewardDistance = Math.abs(nearestOppositeZone - entryPrice);
    if (rewardDistance / stopDistance >= minRR) {
      return { entry: entryPrice, stopLoss, takeProfit: nearestOppositeZone };
    }
  }

  return { entry: entryPrice, stopLoss, takeProfit: fallbackTakeProfit };
}

// Structural stop/target for strong-order-block-reaction —
// sltp-geometry-source-variant-A.md §1: stop is beyond the REACTING block's
// own edge (block.bottom for a buy/support reaction, block.top for a
// sell/resistance reaction) — geometrically identical in shape to
// computeLiquiditySweepTradeLevels (edge ± buffer*ATR, target = nearest
// opposite smartMoney zone gated by minRR, else 2x-stopDistance fallback).
// A dedicated wrapper for the same reason as computeOrderBlockBreakerTradeLevels
// above: self-documenting per-pattern entry in signal-builder.ts /
// pattern-audit-checklist.md, without duplicating the tested geometry.
export function computeStrongOrderBlockReactionTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  blockBottom: number,
  blockTop: number,
  nearestOppositeZone: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    blockBottom,
    blockTop,
    nearestOppositeZone,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target for macd-deceleration-continuation —
// pattern-audit-checklist.md Группа 2: stop is beyond the deceleration
// ("pause") candle's own extreme, target is the nearest structural level
// (S/R/OB) in the continuation direction via smartMoney — same geometry
// SHAPE as computeLiquiditySweepTradeLevels. Dedicated wrapper for the same
// reason as the other Group 2 patterns above (self-documenting per-pattern
// entry, no duplicated logic).
export function computeMacdDecelerationTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  pauseCandleLow: number,
  pauseCandleHigh: number,
  nearestOppositeZone: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    pauseCandleLow,
    pauseCandleHigh,
    nearestOppositeZone,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target for Rising/Falling Three Methods (Группа 4 —
// pattern-audit-checklist.md): stop beyond the low/high of the 4-candle
// pre-confirmation formation (impulse + 3-candle consolidation, excluding
// the breakout confirmation candle itself), target is the classical
// "measure rule" projection (impulse candle 1's body height projected from
// the close of the confirmation candle) — precomputed by the detector.
// Same geometry SHAPE as computeLiquiditySweepTradeLevels (RR-gated with a
// 2x-stopDistance fallback), reused here as the safety net for the rare
// case of a disproportionately small impulse candle.
export function computeThreeMethodsTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  formationLow: number,
  formationHigh: number,
  measuredMoveTarget: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    formationLow,
    formationHigh,
    measuredMoveTarget,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target shared by the classic Price Action candlestick
// pattern family (Группа 3 в pattern-audit-checklist.md: single.ts /
// double.ts / triple.ts / pin-bar.ts, plus Группа 4's Three Methods in
// continuation.ts) — standard price-action convention, not project-
// specific: stop beyond the formation's own invalidating extreme (not an
// arbitrary ATR multiple), target either the nearest structural zone via
// smartMoney or a measured-move projection, whichever the detector decided
// to expose as its precomputed target candidate. Same geometry SHAPE as
// computeLiquiditySweepTradeLevels — one shared function across this whole
// family rather than ~20 near-identical per-pattern wrappers, since (unlike
// the Group 2 family) none of these patterns need extra parameters beyond
// "formation low/high" + "precomputed target".
export function computeCandlestickTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  formationLow: number,
  formationHigh: number,
  structuralTarget: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    formationLow,
    formationHigh,
    structuralTarget,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target for order-block-nested — pattern-audit-
// checklist.md Группа 2, same principle as computeFvgTradeLevels above (its
// FVG counterpart): stop is beyond the M1-nested OB's own boundary, target
// is the containing HTF zone's near boundary in the trade direction —
// precomputed by the detector, this function only applies the shared
// RR-gate/fallback policy on top. Same geometry SHAPE as
// computeLiquiditySweepTradeLevels; a dedicated wrapper per the checklist's
// "своя функция, переиспользовать логику с fvg-nested" instruction.
export function computeOrderBlockNestedTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  m1Bottom: number,
  m1Top: number,
  htfBoundary: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    m1Bottom,
    m1Top,
    htfBoundary,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target shared by the WHOLE FVG pattern family
// (fvg-return / fvg-rejection / fvg-breaker-block / fvg-nested) —
// pattern-audit-checklist.md Группа 2 explicitly asks to consolidate these
// into one function rather than 4 near-duplicates, since the geometry SHAPE
// is identical across all of them: stop = zone's own boundary ± buffer×ATR,
// target gated by minRR with the shared 2x-stopDistance fallback (see
// sltp-geometry-source-variant-A.md §2). `structuralTarget` is precomputed
// by each detector using whichever method fits it — nearest opposite
// smartMoney zone for return/rejection/breaker-block, the containing HTF
// zone's own boundary for nested — this function only applies the shared
// RR-gate/fallback policy on top, it doesn't decide HOW that target was
// found.
export function computeFvgTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  fvgBottom: number,
  fvgTop: number,
  structuralTarget: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    fvgBottom,
    fvgTop,
    structuralTarget,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target for order-block-breaker — sltp-geometry-source-
// variant-A.md §1: same geometry SHAPE as computeLiquiditySweepTradeLevels
// (stop beyond a swept extreme + buffer*ATR, target = nearest opposite
// smartMoney zone gated by minRR, else 2x-stopDistance fallback) — but the
// swept extreme here is NOT the breaker block's own top/bottom (that would
// just be the origin OB's un-inverted extremes), it's the candle that
// broke/invalidated the origin Order Block and thereby created the
// breaker — the actual liquidity-sweep candle, per the source doc's
// "beyond the tail of the liquidity sweep, not just behind the Breaker
// body". A thin, dedicated wrapper (rather than every call site reaching
// for computeLiquiditySweepTradeLevels directly) keeps this pattern's own
// entry in signal-builder.ts self-documenting, per pattern-audit-
// checklist.md's per-pattern "Действие А" tracking, while reusing the
// identical, already-tested geometry rather than duplicating it.
export function computeOrderBlockBreakerTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  sweepWickLow: number,
  sweepWickHigh: number,
  nearestOppositeZone: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    sweepWickLow,
    sweepWickHigh,
    nearestOppositeZone,
    atrValue,
    buffer,
    minRR,
  );
}

// Structural stop/target for the BASE liquidity-sweep pattern (not
// -reaction) — refactor variant A, Фаза 0' группа 2 / sltp-geometry-source-
// variant-A.md §3. Same stop geometry as computeLiquiditySweepTradeLevels
// (beyond the sweep bar's own extreme), but the target genuinely differs by
// `setupType`, so this pattern cannot just reuse that function as-is:
//
// - 'continuation' (pure ICT liquidity sweep before continuation): target
//   is the next liquidity draw — nearestOppositeZone via smartMoney, same as
//   liquidity-sweep-reaction — with the same minRR-gated 2x-stopDistance
//   fallback.
// - 'reversal-at-key-level' (methodologically Wyckoff Spring/Upthrust):
//   target is the OPPOSITE boundary of the same local Trading Range the
//   spring/upthrust occurred in (rangeHigh for a buy-spring, rangeLow for a
//   sell-upthrust) — NOT a smartMoney zone. Still gated by minRR with the
//   same fallback, so an unusually narrow range doesn't produce a
//   degenerate near-zero-R:R target.
export function computeLiquiditySweepBaseTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  setupType: 'continuation' | 'reversal-at-key-level',
  sweepLow: number,
  sweepHigh: number,
  nearestOppositeZone: number | null,
  rangeHigh: number,
  rangeLow: number,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  const stopLoss =
    direction === 'buy'
      ? sweepLow - atrValue * buffer
      : sweepHigh + atrValue * buffer;
  const stopDistance = Math.abs(entryPrice - stopLoss);

  const fallbackTakeProfit =
    direction === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

  const structuralTarget =
    setupType === 'reversal-at-key-level'
      ? (direction === 'buy' ? rangeHigh : rangeLow)
      : nearestOppositeZone;

  if (structuralTarget !== null && stopDistance > 0) {
    const rewardDistance = Math.abs(structuralTarget - entryPrice);
    if (rewardDistance / stopDistance >= minRR) {
      return { entry: entryPrice, stopLoss, takeProfit: structuralTarget };
    }
  }

  return { entry: entryPrice, stopLoss, takeProfit: fallbackTakeProfit };
}

// Structural TP for order-block-continuation (audit finding #3: targetZone
// was computed by findTargetZone() in the detector but never used — the signal
// fell through to estimateTradeLevels with a flat ATR×2 TP that ignores real
// market structure). Uses the same pattern as computeLiquiditySweepTradeLevels:
// structural target is used only if it yields RR >= minRR, otherwise falls back
// to the shared computeTradeLevels TP. Stop loss stays at the shared ATR-based
// level — OBC doesn't have a structural stop like breakout/sweep do.
export function computeOrderBlockContinuationTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  targetZone: number | undefined,
  atrValue: number,
  atrMultiplier: number,
  minRR: number = 1.5,
): TradeLevels {
  const base = computeTradeLevels(entryPrice, atrValue, atrMultiplier, direction);
  if (targetZone === undefined) return base;

  const stopDistance = Math.abs(entryPrice - base.stopLoss);
  const rewardDistance = Math.abs(targetZone - entryPrice);
  if (stopDistance > 0 && rewardDistance / stopDistance >= minRR) {
    return { ...base, takeProfit: targetZone };
  }
  return base;
}

// Structural SL/TP for harmonic patterns (Gartley/Butterfly/AB=CD) — same
// two-step approach as computeLiquiditySweepTradeLevels/
// computeOrderBlockContinuationTradeLevels above. The detector precomputes
// harmonicStop (beyond point D/X, with an ATR buffer already baked in) and
// harmonicTarget (a Fibonacci projection off point D). The structural
// SL/TP pair is used only if it clears minRR; otherwise falls back entirely
// to the shared ATR-based computeTradeLevels (stop included — unlike OBC,
// a harmonic pattern has no separate "generic" stop of its own to keep).
export function computeHarmonicTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  harmonicStop: number | undefined,
  harmonicTarget: number | undefined,
  atrValue: number,
  atrMultiplier: number,
  minRR: number = 1.5,
): TradeLevels {
  const base = computeTradeLevels(entryPrice, atrValue, atrMultiplier, direction);
  if (harmonicStop === undefined || harmonicTarget === undefined) return base;

  const stopDistance = Math.abs(entryPrice - harmonicStop);
  const rewardDistance = Math.abs(harmonicTarget - entryPrice);
  if (stopDistance > 0 && rewardDistance / stopDistance >= minRR) {
    return { entry: entryPrice, stopLoss: harmonicStop, takeProfit: harmonicTarget };
  }
  return base;
}

// Refactor variant A, Фаза 0' (пробел, закрыт при углублённом аудите
// качества рефакторинга — не входил в исходные Группы 1-4 чек-листа,
// т.к. consolidation-breakout/inside-bar/mean-reversion добавлены в
// проект позже основного корпуса паттернов, но уже классифицированы в
// pattern-horizon.ts и активно торгуются): все три раньше молча
// резолвились через generic estimateTradeLevels() (ATR×2 от entryPrice) —
// ровно тот путь, который промт (Фаза −1, п.2) требует оставить ТОЛЬКО
// safety-net'ом для неклассифицированных паттернов, а не дефолтом для
// активных детекторов. Все три имеют собственную, уже вычисленную
// детектором структуру (диапазон сжатия / материнская свеча / бар выхода
// за полосу Боллинджера) — геометрическая ФОРМА идентична
// computeLiquiditySweepTradeLevels (stop = структурный экстремум ±
// buffer×ATR, target = предвычисленный структурный таргет, gated минимальным
// R:R с тем же ATR×2-фолбэком), поэтому тонкие обёртки, а не дублирование
// логики — тот же паттерн, что уже применён к 8 другим детекторам выше.
export function computeConsolidationBreakoutTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  rangeLow: number,
  rangeHigh: number,
  measuredMoveTarget: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    rangeLow,
    rangeHigh,
    measuredMoveTarget,
    atrValue,
    buffer,
    minRR,
  );
}

// inside-bar — stop beyond the OPPOSITE extreme of the mother candle (a full
// reclaim of the mother's range invalidates the compression-breakout thesis),
// target is the classical measured move (mother candle's range height
// projected from the breakout close). Same geometry shape as
// computeConsolidationBreakoutTradeLevels above — see its comment.
export function computeInsideBarTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  motherLow: number,
  motherHigh: number,
  measuredMoveTarget: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    motherLow,
    motherHigh,
    measuredMoveTarget,
    atrValue,
    buffer,
    minRR,
  );
}

// mean-reversion — stop beyond the extreme of the rejection bar (the candle
// that poked outside the Bollinger Band and whose depth-beyond-band already
// feeds this pattern's own confidence score), target is the Bollinger middle
// band itself — the literal, canonical "mean" this strategy is named after,
// not a derived structural zone. Same geometry shape as
// computeConsolidationBreakoutTradeLevels above — see its comment. Unlike
// the other two, the target here is rarely gated out by minRR in practice
// (the entry only fires after price has already travelled most of the way
// back from outside the band, so the remaining distance to the middle band
// is usually still meaningfully larger than the tight rejection-bar stop),
// but the same fallback is kept for consistency and for the rare edge case
// of an unusually wide rejection bar.
export function computeMeanReversionTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  rejectionLow: number,
  rejectionHigh: number,
  bollingerMiddle: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  return computeLiquiditySweepTradeLevels(
    entryPrice,
    direction,
    rejectionLow,
    rejectionHigh,
    bollingerMiddle,
    atrValue,
    buffer,
    minRR,
  );
}

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
