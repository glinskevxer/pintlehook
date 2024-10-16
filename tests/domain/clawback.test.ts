import { describe, expect, it } from 'vitest';
import {
  assessClawback,
  claimOrder,
  describeClawback,
  isChargedBack,
  type CargoClaim,
  type ClawbackInput,
} from '../../src/domain/clawback.js';
import { claimId, loadId } from '../../src/domain/identity.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const window = interval(day(2025, 1, 6), day(2025, 7, 5));

function claim(
  sequence: number,
  on: ReturnType<typeof day>,
  amountMinor: number,
  disposition: CargoClaim['disposition'] = 'charged_to_carrier',
): CargoClaim {
  return {
    id: claimId(sequence),
    load: loadId(sequence),
    raisedOn: on,
    disposition,
    amountMinor,
    currency: 'USD',
  };
}

function run(overrides: Partial<ClawbackInput> = {}) {
  return unwrap(
    assessClawback({
      claims: [],
      deliveredMargin: money('USD', 400_000),
      retentionFailedOn: undefined,
      policy: { claimToleranceShare: 2500, retentionWindow: window, currency: 'USD' },
      ...overrides,
    }),
  );
}

describe('isChargedBack', () => {
  it('needs the claim charged to the carrier', () => {
    expect(isChargedBack(claim(1, day(2025, 3, 1), 10_000), window)).toBe(true);
    expect(isChargedBack(claim(1, day(2025, 3, 1), 10_000, 'absorbed'), window)).toBe(false);
    expect(isChargedBack(claim(1, day(2025, 3, 1), 10_000, 'denied'), window)).toBe(false);
    expect(isChargedBack(claim(1, day(2025, 3, 1), 10_000, 'open'), window)).toBe(false);
  });

  it('needs the claim raised inside the retention window', () => {
    expect(isChargedBack(claim(1, day(2025, 7, 5), 10_000), window)).toBe(false);
    expect(isChargedBack(claim(1, day(2025, 1, 5), 10_000), window)).toBe(false);
  });
});

describe('no clawback', () => {
  it('leaves a clean referral alone', () => {
    const outcome = run();
    expect(outcome.clawed).toBe(false);
    expect(outcome.chargedTotal.minor).toBe(0);
    expect(outcome.marginAfterClaims.minor).toBe(400_000);
  });

  it('tolerates a small claim', () => {
    const outcome = run({ claims: [claim(1, day(2025, 3, 1), 90_000)] });
    expect(outcome.clawed).toBe(false);
    expect(outcome.tolerance.minor).toBe(100_000);
  });

  it('tolerates a claim exactly at the tolerance', () => {
    expect(run({ claims: [claim(1, day(2025, 3, 1), 100_000)] }).clawed).toBe(false);
  });

  it('ignores an absorbed claim however large', () => {
    const outcome = run({ claims: [claim(1, day(2025, 3, 1), 900_000, 'absorbed')] });
    expect(outcome.clawed).toBe(false);
    expect(outcome.chargedClaims).toHaveLength(0);
  });

  it('ignores a claim raised after the retention window closed', () => {
    expect(run({ claims: [claim(1, day(2025, 8, 1), 900_000)] }).clawed).toBe(false);
  });
});

describe('claim chargeback', () => {
  it('claws back once the tolerance is passed', () => {
    const outcome = run({ claims: [claim(1, day(2025, 3, 1), 100_001)] });
    expect(outcome.clawed).toBe(true);
    expect(outcome.reason).toBe('claim_chargeback');
    expect(outcome.on).toEqual(day(2025, 3, 1));
  });

  it('dates it to the claim that broke the tolerance', () => {
    const outcome = run({
      claims: [
        claim(1, day(2025, 2, 1), 60_000),
        claim(2, day(2025, 4, 1), 60_000),
        claim(3, day(2025, 6, 1), 60_000),
      ],
    });
    expect(outcome.on).toEqual(day(2025, 4, 1));
  });

  it('does not depend on the order the claims arrived in', () => {
    const claims = [
      claim(3, day(2025, 6, 1), 60_000),
      claim(1, day(2025, 2, 1), 60_000),
      claim(2, day(2025, 4, 1), 60_000),
    ];
    expect(run({ claims }).on).toEqual(day(2025, 4, 1));
  });

  it('reports the margin left after the claims', () => {
    const outcome = run({ claims: [claim(1, day(2025, 3, 1), 150_000)] });
    expect(outcome.marginAfterClaims.minor).toBe(250_000);
  });

  it('does not claw back the same claims when the margin is bigger', () => {
    const outcome = run({
      claims: [claim(1, day(2025, 3, 1), 150_000)],
      deliveredMargin: money('USD', 900_000),
    });
    expect(outcome.clawed).toBe(false);
  });
});

describe('retention failure', () => {
  it('claws back on its own', () => {
    const outcome = run({ retentionFailedOn: day(2025, 5, 5) });
    expect(outcome.clawed).toBe(true);
    expect(outcome.reason).toBe('retention_failed');
    expect(outcome.on).toEqual(day(2025, 5, 5));
  });

  it('takes the earlier of the two reasons', () => {
    const outcome = run({
      claims: [claim(1, day(2025, 6, 1), 200_000)],
      retentionFailedOn: day(2025, 5, 5),
    });
    expect(outcome.reason).toBe('retention_failed');
    expect(outcome.on).toEqual(day(2025, 5, 5));
  });

  it('lets the claim win when it landed first', () => {
    const outcome = run({
      claims: [claim(1, day(2025, 2, 1), 200_000)],
      retentionFailedOn: day(2025, 5, 5),
    });
    expect(outcome.reason).toBe('claim_chargeback');
    expect(outcome.on).toEqual(day(2025, 2, 1));
  });

  it('prefers retention when both fall on the same day', () => {
    const outcome = run({
      claims: [claim(1, day(2025, 5, 5), 200_000)],
      retentionFailedOn: day(2025, 5, 5),
    });
    expect(outcome.reason).toBe('retention_failed');
  });
});

describe('currency', () => {
  it('refuses a margin in another currency', () => {
    const r = assessClawback({
      claims: [],
      deliveredMargin: money('CAD', 400_000),
      retentionFailedOn: undefined,
      policy: { claimToleranceShare: 2500, retentionWindow: window, currency: 'USD' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('clawback_currency_mismatch');
    }
  });

  it('refuses a claim in another currency', () => {
    const foreign: CargoClaim = { ...claim(1, day(2025, 3, 1), 10_000), currency: 'MXN' };
    const r = assessClawback({
      claims: [foreign],
      deliveredMargin: money('USD', 400_000),
      retentionFailedOn: undefined,
      policy: { claimToleranceShare: 2500, retentionWindow: window, currency: 'USD' },
    });
    expect(isErr(r)).toBe(true);
  });
});

describe('claimOrder', () => {
  it('sorts by amount', () => {
    const ordered = claimOrder([claim(1, day(2025, 2, 1), 900), claim(2, day(2025, 3, 1), 100)]);
    expect(ordered[0]!.amountMinor).toBe(100);
  });
});

describe('describeClawback', () => {
  it('says nothing happened', () => {
    expect(describeClawback(run())).toBe('no clawback');
  });

  it('names the reason', () => {
    expect(describeClawback(run({ retentionFailedOn: day(2025, 5, 5) }))).toContain(
      'retention_failed',
    );
  });
});
