import { describe, expect, it } from 'vitest';
import {
  assessHold,
  describeHold,
  isReleasable,
  reasonRank,
  releasableByHand,
  type HoldInput,
} from '../../src/domain/hold.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';

function input(overrides: Partial<HoldInput> = {}): HoldInput {
  return {
    netPosition: money('USD', 80_000),
    recoveryOutstanding: money('USD', 0),
    releaseCeiling: money('USD', 100_000),
    minimumPayout: money('USD', 5_000),
    openEligibilityFlags: [],
    hasRemitDetails: true,
    programYearCapReached: false,
    asOf: day(2025, 6, 1),
    ...overrides,
  };
}

describe('a clean advocate', () => {
  it('is clear to pay', () => {
    const verdict = assessHold(input());
    expect(verdict.held).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.primaryReason).toBeUndefined();
  });
});

describe('negative position', () => {
  it('holds', () => {
    const verdict = assessHold(input({ netPosition: money('USD', -1) }));
    expect(verdict.held).toBe(true);
    expect(verdict.reasons).toContain('negative_position');
  });

  it('does not hold a position of exactly nothing on the minimum rule', () => {
    const verdict = assessHold(input({ netPosition: money('USD', 0) }));
    expect(verdict.held).toBe(false);
  });
});

describe('recovery over the ceiling', () => {
  it('holds above the ceiling', () => {
    const verdict = assessHold(input({ recoveryOutstanding: money('USD', 100_001) }));
    expect(verdict.reasons).toContain('recovery_over_ceiling');
  });

  it('does not hold at the ceiling', () => {
    const verdict = assessHold(input({ recoveryOutstanding: money('USD', 100_000) }));
    expect(verdict.held).toBe(false);
  });
});

describe('eligibility flags', () => {
  it('holds on any open flag', () => {
    const verdict = assessHold(input({ openEligibilityFlags: ['w9 missing'] }));
    expect(verdict.reasons).toEqual(['eligibility_flag_open']);
  });
});

describe('remit details', () => {
  it('holds when there is nowhere to send the money', () => {
    expect(assessHold(input({ hasRemitDetails: false })).reasons).toContain('no_remit_details');
  });
});

describe('the program year cap', () => {
  it('holds once the cap is reached', () => {
    expect(assessHold(input({ programYearCapReached: true })).reasons).toContain(
      'program_year_cap_reached',
    );
  });
});

describe('the minimum payout', () => {
  it('holds a small positive amount', () => {
    expect(assessHold(input({ netPosition: money('USD', 4_999) })).reasons).toContain(
      'below_minimum',
    );
  });

  it('pays exactly the minimum', () => {
    expect(assessHold(input({ netPosition: money('USD', 5_000) })).held).toBe(false);
  });

  it('does not add the minimum reason to a negative position', () => {
    const verdict = assessHold(input({ netPosition: money('USD', -100) }));
    expect(verdict.reasons).not.toContain('below_minimum');
  });
});

describe('several reasons at once', () => {
  const verdict = assessHold(
    input({
      netPosition: money('USD', -1),
      recoveryOutstanding: money('USD', 200_000),
      openEligibilityFlags: ['under review'],
      hasRemitDetails: false,
    }),
  );

  it('collects every reason', () => {
    expect(verdict.reasons).toHaveLength(4);
  });

  it('ranks the eligibility flag first', () => {
    expect(verdict.primaryReason).toBe('eligibility_flag_open');
  });

  it('orders the rest by rank', () => {
    expect(verdict.reasons).toEqual([
      'eligibility_flag_open',
      'negative_position',
      'recovery_over_ceiling',
      'no_remit_details',
    ]);
  });
});

describe('reasonRank', () => {
  it('gives every reason a distinct rank', () => {
    const ranks = [
      'eligibility_flag_open',
      'negative_position',
      'recovery_over_ceiling',
      'no_remit_details',
      'program_year_cap_reached',
      'below_minimum',
    ].map((reason) => reasonRank(reason as Parameters<typeof reasonRank>[0]));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('releasing by hand', () => {
  it('lets the desk lift a small amount or a missing remit', () => {
    expect(isReleasable('below_minimum')).toBe(true);
    expect(isReleasable('no_remit_details')).toBe(true);
    expect(isReleasable('negative_position')).toBe(false);
  });

  it('will not let the desk lift a mixed hold', () => {
    const verdict = assessHold(input({ netPosition: money('USD', -1), hasRemitDetails: false }));
    expect(releasableByHand(verdict)).toBe(false);
  });

  it('lets the desk lift a hold that is only releasable reasons', () => {
    const verdict = assessHold(input({ netPosition: money('USD', 100), hasRemitDetails: false }));
    expect(releasableByHand(verdict)).toBe(true);
  });

  it('says nothing to release when the advocate is clear', () => {
    expect(releasableByHand(assessHold(input()))).toBe(false);
  });
});

describe('describeHold', () => {
  it('says it is clear', () => {
    expect(describeHold(assessHold(input()))).toBe('clear to pay');
  });

  it('lists the reasons', () => {
    expect(describeHold(assessHold(input({ hasRemitDetails: false })))).toContain(
      'no_remit_details',
    );
  });
});
