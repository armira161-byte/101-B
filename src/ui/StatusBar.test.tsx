import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '@/ui/StatusBar';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { useTickStore } from '@/stores/useTickStore';
import type { Signal } from '@/types/domain';

function makeSignal(overrides: Partial<Signal> & { id: string }): Signal {
  return {
    symbolId: 'BTCUSDT',
    direction: 'buy',
    strength: 'moderate',
    score: 3,
    calibratedProbability: 0.6,
    entryPrice: 100,
    stopLoss: 99.0,
    takeProfit: 101.5,
    reason: 'test',
    indicators: {} as unknown as Signal['indicators'],
    pattern: null,
    time: 1000,
    timeframe: '5m',
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve: 5,
    spread: null,
    spreadSource: null,
    recommendedExpiry: 300,
    featureVector: [],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

// РЕФАКТОРИНГ (бинарные опционы, Фаза 5 — "продуктовая честность"):
// StatusBar теперь показывает payout рядом с винрейтом, и цвет винрейта
// зависит от РЕАЛЬНОГО безубытка при текущей выплате, а не от
// захардкоженных 45%/60% — эти тесты фиксируют оба поведения.
describe('StatusBar — payout and breakeven-relative winRate tone', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
    useTickStore.setState({ candles: [], currentPrice: 100, loading: false, error: null, sourceFallbackNotice: null, marketClosed: false, lastPriceFlash: null });
  });

  it('displays the current payout percentage next to the win rate', () => {
    useDemoAccountStore.getState().setProfitPercent(80);
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
    useAnalyticsStore.getState().recomputeStats();

    render(<StatusBar />);

    expect(screen.getByText('выплата')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('does not render the win rate/payout badge when there is no resolved trade history yet', () => {
    useDemoAccountStore.getState().setProfitPercent(80);
    render(<StatusBar />);
    expect(screen.queryByText('выплата')).not.toBeInTheDocument();
  });

  it('reflects a lower payout requiring a higher win rate to break even', () => {
    // 50% win rate is BELOW breakeven at payout=80% (needs ~55.56%).
    useDemoAccountStore.getState().setProfitPercent(80);
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
    useAnalyticsStore.getState().recomputeStats();

    render(<StatusBar />);
    const winRateEl = screen.getByText('50%');
    expect(winRateEl.className).toContain('text-error-400');
  });

  it('shows the same 50% win rate as healthy (not error) at a high enough payout', () => {
    // At payout=200% breakeven would be ~33.3% (never happens with real
    // binary-options brokers, but proves the tone is derived from payout,
    // not a fixed threshold).
    useDemoAccountStore.getState().setProfitPercent(200);
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's1', outcome: 'win' }));
    useAnalyticsStore.getState().addSignal(makeSignal({ id: 's2', outcome: 'loss' }));
    useAnalyticsStore.getState().recomputeStats();

    render(<StatusBar />);
    const winRateEl = screen.getByText('50%');
    expect(winRateEl.className).toContain('text-success-400');
  });
});
