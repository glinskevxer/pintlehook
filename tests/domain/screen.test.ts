import { describe, expect, it } from 'vitest';
import { carrierId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import {
  SCREEN_SIGNALS,
  SCREEN_THRESHOLD,
  describeVerdict,
  requireDistinct,
  screenPairKey,
  screenParties,
  signalWeight,
} from '../../src/domain/screen.js';
import { isErr, unwrap } from '../../src/util/result.js';

const advocate: Party = {
  id: carrierId(1),
  legalName: 'Brannan Hauling LLC',
  motorCarrierNumber: 'MC884210',
  dotNumber: '3126540',
  authorityStatus: 'active',
  remit: { line1: '4120 W Harrison St', city: 'Joliet', state: 'IL', postalCode: '60431' },
  bank: { routingDigest: 'r1', accountDigest: 'a1' },
  powerUnits: 3,
};

const stranger: Party = {
  id: carrierId(2),
  legalName: 'Delacroix Transport Inc',
  motorCarrierNumber: 'MC991002',
  dotNumber: '4410781',
  authorityStatus: 'active',
  remit: { line1: '18 Bayou Rd', city: 'Houma', state: 'LA', postalCode: '70360' },
  bank: { routingDigest: 'r2', accountDigest: 'a2' },
  powerUnits: 1,
};

describe('signals', () => {
  it('names six signals and weights every one of them', () => {
    expect(SCREEN_SIGNALS).toHaveLength(6);
    for (const signal of SCREEN_SIGNALS) {
      expect(signalWeight(signal)).toBeGreaterThan(0);
    }
  });

  it('sets the threshold at one strong signal', () => {
    expect(signalWeight('same_authority')).toBe(SCREEN_THRESHOLD);
  });
});

describe('screenParties', () => {
  it('clears two unrelated carriers', () => {
    const verdict = screenParties(advocate, stranger);
    expect(verdict.screened).toBe(false);
    expect(verdict.signals).toEqual([]);
    expect(verdict.score).toBe(0);
  });

  it('screens a carrier against itself', () => {
    const verdict = screenParties(advocate, advocate);
    expect(verdict.screened).toBe(true);
    expect(verdict.signals).toContain('same_carrier');
  });

  it('screens on a shared motor carrier number alone', () => {
    const twin: Party = { ...stranger, motorCarrierNumber: advocate.motorCarrierNumber };
    const verdict = screenParties(advocate, twin);
    expect(verdict.screened).toBe(true);
    expect(verdict.signals).toEqual(['same_authority']);
  });

  it('screens on a shared bank account alone', () => {
    const twin: Party = { ...stranger, bank: advocate.bank };
    expect(screenParties(advocate, twin).screened).toBe(false);
  });

  it('screens on a shared bank account plus a shared remit address', () => {
    const twin: Party = { ...stranger, bank: advocate.bank, remit: advocate.remit };
    const verdict = screenParties(advocate, twin);
    expect(verdict.score).toBe(140);
    expect(verdict.screened).toBe(true);
  });

  it('does not screen on a shared remit address alone', () => {
    const twin: Party = { ...stranger, remit: advocate.remit };
    const verdict = screenParties(advocate, twin);
    expect(verdict.signals).toEqual(['same_remit']);
    expect(verdict.screened).toBe(false);
  });

  it('screens on a shared remit address plus the same trading name', () => {
    const twin: Party = {
      ...stranger,
      remit: advocate.remit,
      legalName: 'Brannan Hauling, Inc.',
    };
    expect(screenParties(advocate, twin).screened).toBe(true);
  });

  it('ignores a bank match when only one side has an account on file', () => {
    const noBank: Party = { ...advocate, bank: undefined };
    expect(screenParties(noBank, { ...stranger, bank: advocate.bank }).signals).toEqual([]);
  });

  it('is symmetric', () => {
    const twin: Party = { ...stranger, dotNumber: advocate.dotNumber };
    expect(screenParties(advocate, twin).score).toBe(screenParties(twin, advocate).score);
  });
});

describe('screenPairKey', () => {
  it('does not depend on which side is the advocate', () => {
    expect(screenPairKey(advocate, stranger)).toBe(screenPairKey(stranger, advocate));
  });

  it('separates two different pairs', () => {
    const third: Party = { ...stranger, id: carrierId(3) };
    expect(screenPairKey(advocate, third)).not.toBe(screenPairKey(advocate, stranger));
  });
});

describe('describeVerdict', () => {
  it('says nothing was found', () => {
    expect(describeVerdict(screenParties(advocate, stranger))).toBe('no common authority signals');
  });

  it('says what was found below the threshold', () => {
    const twin: Party = { ...stranger, remit: advocate.remit };
    expect(describeVerdict(screenParties(advocate, twin))).toContain('below threshold at 60');
  });

  it('lists the signals that fired', () => {
    expect(describeVerdict(screenParties(advocate, advocate))).toContain('same_carrier');
  });
});

describe('requireDistinct', () => {
  it('returns the verdict when the pair clears', () => {
    expect(unwrap(requireDistinct(advocate, stranger)).screened).toBe(false);
  });

  it('fails when the pair is screened', () => {
    const r = requireDistinct(advocate, advocate);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('screen_common_authority');
    }
  });
});
