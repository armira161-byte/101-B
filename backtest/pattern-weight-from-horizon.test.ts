import { describe, it, expect } from 'vitest';
import type { PatternName } from '@/types/domain';
import { binomialSignificanceTest, MIN_SAMPLES_FOR_SIGNIFICANCE } from './significance';
import type { HorizonEvalResult, PatternHorizonHypothesis } from './pattern-horizon';
import {
  computePatternWeightDecisions,
  toPatternWeightUpdates,
  formatPatternWeightReportMarkdown,
} from './pattern-weight-from-horizon';

function hypothesis(overrides: Partial<PatternHorizonHypothesis> & { row: string; patternName: string }): PatternHorizonHypothesis {
  return {
    label: overrides.patternName,
    expiryBarsGrid: [1, 2, 3],
    ...overrides,
  };
}

function result(overrides: Partial<HorizonEvalResult> & { hypothesis: PatternHorizonHypothesis }): HorizonEvalResult {
  return {
    totalEvents: 0,
    bestExpiryBars: null,
    trainValAccuracy: null,
    test: null,
    ...overrides,
  };
}

describe('computePatternWeightDecisions', () => {
  it('excludes a pattern that fails the significance test, regardless of point-estimate accuracy (Фаза 2 п.4)', () => {
    // 52% accuracy "looks" slightly above chance, but at n=300 it's not
    // statistically distinguishable from 50% — must be EXCLUDED (weight 0),
    // not merely down-weighted.
    const h = hypothesis({ row: '1', patternName: 'impulse-breakout' });
    const test = binomialSignificanceTest(156, 300, 0.5); // 52%, not significant
    const rows = computePatternWeightDecisions([result({ hypothesis: h, test, totalEvents: 300 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision.kind).toBe('excluded');
  });

  it('assigns a weight proportional to accuracy for a pattern that passes the significance test', () => {
    const h = hypothesis({ row: '2', patternName: 'liquidity-sweep-reaction' });
    const test = binomialSignificanceTest(210, 300, 0.5); // 70%, clearly significant
    const rows = computePatternWeightDecisions([result({ hypothesis: h, test, totalEvents: 300 })]);
    expect(rows[0].decision.kind).toBe('weighted');
    if (rows[0].decision.kind === 'weighted') {
      expect(rows[0].decision.multiplier).toBeGreaterThan(1);
    }
  });

  it('leaves weight unchanged (not excluded) for insufficient sample size', () => {
    const h = hypothesis({ row: '35', patternName: 'abandoned-baby-bottom' });
    const test = binomialSignificanceTest(30, 50, 0.5); // n=50 < MIN_SAMPLES_FOR_SIGNIFICANCE
    expect(50).toBeLessThan(MIN_SAMPLES_FOR_SIGNIFICANCE);
    const rows = computePatternWeightDecisions([result({ hypothesis: h, test, totalEvents: 50 })]);
    expect(rows[0].decision.kind).toBe('unchanged');
  });

  it('leaves weight unchanged when there is no test at all (pattern never fired)', () => {
    const h = hypothesis({ row: '36', patternName: 'abandoned-baby-top' });
    const rows = computePatternWeightDecisions([result({ hypothesis: h, test: null, totalEvents: 0 })]);
    expect(rows[0].decision.kind).toBe('unchanged');
  });

  it('pools two rows with the same PatternName (liquidity-sweep continuation + reversal) into one decision', () => {
    const continuation = hypothesis({ row: '13', patternName: 'liquidity-sweep', setupTypeFilter: 'continuation' });
    const reversal = hypothesis({ row: '14', patternName: 'liquidity-sweep', setupTypeFilter: 'reversal-at-key-level' });
    // Individually, both are just under the significance sample threshold...
    const testA = binomialSignificanceTest(70, 120, 0.5);
    const testB = binomialSignificanceTest(72, 120, 0.5);
    const rows = computePatternWeightDecisions([
      result({ hypothesis: continuation, test: testA, totalEvents: 120 }),
      result({ hypothesis: reversal, test: testB, totalEvents: 120 }),
    ]);
    // ...but pooled (240 total), there should be exactly ONE row for
    // 'liquidity-sweep', referencing both source rows.
    expect(rows).toHaveLength(1);
    expect(rows[0].patternName).toBe('liquidity-sweep');
    expect(rows[0].sourceRows.sort()).toEqual(['13', '14']);
  });

  it('pooling can rescue two individually-insufficient samples into a significant combined result', () => {
    const a = hypothesis({ row: '13', patternName: 'liquidity-sweep', setupTypeFilter: 'continuation' });
    const b = hypothesis({ row: '14', patternName: 'liquidity-sweep', setupTypeFilter: 'reversal-at-key-level' });
    // 65% accuracy each, but n=110 each is below MIN_SAMPLES_FOR_SIGNIFICANCE individually.
    const testA = binomialSignificanceTest(72, 110, 0.5);
    const testB = binomialSignificanceTest(72, 110, 0.5);
    expect(testA.reason).toBe('insufficient-samples');
    expect(testB.reason).toBe('insufficient-samples');

    const rows = computePatternWeightDecisions([
      result({ hypothesis: a, test: testA, totalEvents: 110 }),
      result({ hypothesis: b, test: testB, totalEvents: 110 }),
    ]);
    // Pooled: 144/220 = 65.5%, n=220 >= MIN_SAMPLES_FOR_SIGNIFICANCE (200).
    expect(rows[0].decision.kind).toBe('weighted');
  });

  it('produces one row per distinct PatternName, sorted', () => {
    const h1 = hypothesis({ row: '1', patternName: 'impulse-breakout' });
    const h2 = hypothesis({ row: '15', patternName: 'hammer' });
    const rows = computePatternWeightDecisions([
      result({ hypothesis: h1, test: null }),
      result({ hypothesis: h2, test: null }),
    ]);
    expect(rows.map((r) => r.patternName)).toEqual(['hammer', 'impulse-breakout']);
  });

  it('takes profitPercent into account: a lower payout raises the breakeven bar, lowering the resulting multiplier for the same accuracy', () => {
    const h = hypothesis({ row: '2', patternName: 'liquidity-sweep-reaction' });
    const test = binomialSignificanceTest(210, 300, 0.5); // 70% accuracy
    const highPayout = computePatternWeightDecisions([result({ hypothesis: h, test })], 95);
    const lowPayout = computePatternWeightDecisions([result({ hypothesis: h, test })], 60);
    const highMult = highPayout[0].decision.kind === 'weighted' ? highPayout[0].decision.multiplier : null;
    const lowMult = lowPayout[0].decision.kind === 'weighted' ? lowPayout[0].decision.multiplier : null;
    expect(highMult).not.toBeNull();
    expect(lowMult).not.toBeNull();
    // Lower payout (60%) means a HIGHER breakeven win rate is required, so
    // the SAME accuracy divided by a bigger breakeven yields a SMALLER
    // multiplier than at a high payout (95%, low breakeven).
    expect(lowMult as number).toBeLessThan(highMult as number);
  });
});

describe('toPatternWeightUpdates', () => {
  it('includes weighted and excluded rows, omits unchanged rows', () => {
    const rows = computePatternWeightDecisions([
      result({ hypothesis: hypothesis({ row: '1', patternName: 'impulse-breakout' }), test: binomialSignificanceTest(210, 300, 0.5) }),
      result({ hypothesis: hypothesis({ row: '17', patternName: 'doji' as PatternName }), test: binomialSignificanceTest(150, 300, 0.5) }),
      result({ hypothesis: hypothesis({ row: '35', patternName: 'abandoned-baby-bottom' }), test: null }),
    ]);
    const updates = toPatternWeightUpdates(rows);
    expect(updates['impulse-breakout']).toBeGreaterThan(1);
    expect(updates['doji']).toBe(0);
    expect('abandoned-baby-bottom' in updates).toBe(false);
  });
});

describe('formatPatternWeightReportMarkdown', () => {
  it('renders a markdown table with one row per pattern', () => {
    const rows = computePatternWeightDecisions([
      result({ hypothesis: hypothesis({ row: '1', patternName: 'impulse-breakout' }), test: binomialSignificanceTest(210, 300, 0.5) }),
    ]);
    const md = formatPatternWeightReportMarkdown(rows);
    expect(md).toContain('| Паттерн |');
    expect(md).toContain('impulse-breakout'.length > 0 ? rows[0].label : '');
  });
});
