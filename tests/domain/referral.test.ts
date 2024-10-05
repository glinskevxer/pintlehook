import { describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import {
  TERMINAL_STATES,
  attribute,
  canMove,
  describeReferral,
  isEarning,
  isTerminal,
  moveTo,
  qualify,
  referralKey,
  reverse,
  type Referral,
} from '../../src/domain/referral.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const recorded: Referral = {
  program: programId(1),
  invitee: carrierId(9),
  advocate: undefined,
  state: 'recorded',
  recordedOn: day(2025, 2, 1),
  effectiveActivation: undefined,
  qualifiedOn: undefined,
  reversedOn: undefined,
};

const attributed = unwrap(attribute(recorded, advocateId(1), day(2025, 3, 1)));
const qualified = unwrap(qualify(attributed, day(2025, 5, 1)));

describe('canMove', () => {
  it('allows the forward moves', () => {
    expect(canMove('recorded', 'attributed')).toBe(true);
    expect(canMove('attributed', 'qualified')).toBe(true);
    expect(canMove('qualified', 'reversed')).toBe(true);
  });

  it('allows a reversal to be put back', () => {
    expect(canMove('reversed', 'qualified')).toBe(true);
  });

  it('allows a lapsed referral to be attributed again', () => {
    expect(canMove('lapsed', 'attributed')).toBe(true);
  });

  it('refuses to skip attribution', () => {
    expect(canMove('recorded', 'qualified')).toBe(false);
  });

  it('lets nothing out of unattributed', () => {
    expect(canMove('unattributed', 'attributed')).toBe(false);
  });
});

describe('isTerminal and isEarning', () => {
  it('names three terminal states', () => {
    expect(TERMINAL_STATES).toHaveLength(3);
    expect(isTerminal('unattributed')).toBe(true);
    expect(isTerminal('qualified')).toBe(false);
  });

  it('only a qualified referral earns', () => {
    expect(isEarning('qualified')).toBe(true);
    expect(isEarning('attributed')).toBe(false);
  });
});

describe('moveTo', () => {
  it('is a no operation to the same state', () => {
    expect(unwrap(moveTo(recorded, 'recorded'))).toEqual(recorded);
  });

  it('refuses a move that is not allowed', () => {
    const r = moveTo(recorded, 'reversed');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_bad_transition');
    }
  });
});

describe('attribute', () => {
  it('records the advocate and the activation', () => {
    expect(attributed.advocate).toBe(advocateId(1));
    expect(attributed.effectiveActivation).toEqual(day(2025, 3, 1));
    expect(attributed.state).toBe('attributed');
  });

  it('refuses an activation before the referral was recorded', () => {
    const r = attribute(recorded, advocateId(1), day(2025, 1, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_activation_before_record');
    }
  });

  it('refuses to attribute an unattributed referral', () => {
    const dead: Referral = { ...recorded, state: 'unattributed' };
    expect(isErr(attribute(dead, advocateId(1), day(2025, 3, 1)))).toBe(true);
  });
});

describe('qualify', () => {
  it('records the qualifying day', () => {
    expect(qualified.qualifiedOn).toEqual(day(2025, 5, 1));
    expect(qualified.state).toBe('qualified');
  });

  it('refuses a referral with no advocate', () => {
    const r = qualify(recorded, day(2025, 5, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_qualify_unattributed');
    }
  });

  it('refuses a referral with no activation', () => {
    const odd: Referral = { ...attributed, effectiveActivation: undefined };
    const r = qualify(odd, day(2025, 5, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_qualify_unactivated');
    }
  });

  it('refuses a qualifying day before the activation', () => {
    const r = qualify(attributed, day(2025, 2, 15));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_qualify_before_activation');
    }
  });

  it('clears a previous reversal when a referral qualifies again', () => {
    const reversed = unwrap(reverse(qualified, day(2025, 7, 1)));
    const again = unwrap(qualify(reversed, day(2025, 8, 1)));
    expect(again.reversedOn).toBeUndefined();
    expect(again.qualifiedOn).toEqual(day(2025, 8, 1));
  });
});

describe('reverse', () => {
  it('records the reversal day', () => {
    const reversed = unwrap(reverse(qualified, day(2025, 7, 1)));
    expect(reversed.state).toBe('reversed');
    expect(reversed.reversedOn).toEqual(day(2025, 7, 1));
  });

  it('refuses to reverse something that never qualified', () => {
    const r = reverse(attributed, day(2025, 7, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_reverse_unqualified');
    }
  });

  it('refuses a reversal dated before the qualification', () => {
    const r = reverse(qualified, day(2025, 4, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('referral_reverse_before_qualification');
    }
  });
});

describe('referralKey and describeReferral', () => {
  it('keys on the program and the invitee', () => {
    expect(referralKey(recorded)).toBe(`${programId(1)}:${carrierId(9)}`);
  });

  it('says nobody when there is no advocate', () => {
    expect(describeReferral(recorded)).toContain('nobody');
    expect(describeReferral(attributed)).toContain(advocateId(1));
  });
});
