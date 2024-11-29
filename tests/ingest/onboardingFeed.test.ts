import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/ingest/envelope.js';
import {
  ONBOARDING_COLUMNS,
  awaitingInsurance,
  readOnboardingFeed,
  readOnboardingRow,
} from '../../src/ingest/onboardingFeed.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const envelope = unwrap(
  readEnvelope({
    source: 'compliance',
    kind: 'onboarding',
    cutAt: '2025-04-01T06:00:00Z',
    declaredRows: 1,
    zone: 'America/Chicago',
    sequence: 42,
  }),
);

function row(overrides: Record<string, string> = {}) {
  return {
    mc_number: 'MC-884210',
    dot_number: 'USDOT 3126540',
    legal_name: 'Brannan Hauling LLC',
    approval_kind: 'conditional',
    approved_on: '2025-02-10',
    insurance_cleared_on: '2025-02-20',
    authority_status: 'active',
    power_units: '2',
    referral_code: 'AB3K9ZQ',
    ...overrides,
  };
}

describe('columns', () => {
  it('names the seven that have to be there', () => {
    expect(ONBOARDING_COLUMNS).toHaveLength(7);
  });
});

describe('readOnboardingRow', () => {
  it('reads a good row', () => {
    const draft = unwrap(readOnboardingRow(envelope, row(), 1));
    expect(draft.motorCarrierNumber).toBe('MC884210');
    expect(draft.dotNumber).toBe('3126540');
    expect(draft.approvalKind).toBe('conditional');
    expect(draft.approvedOn).toEqual(day(2025, 2, 10));
    expect(draft.insuranceClearedOn).toEqual(day(2025, 2, 20));
    expect(draft.powerUnits).toBe(2);
  });

  it('normalises two spellings of the same authority', () => {
    const one = unwrap(readOnboardingRow(envelope, row({ mc_number: 'MC-0884210' }), 1));
    const two = unwrap(readOnboardingRow(envelope, row({ mc_number: '884210' }), 1));
    expect(one.motorCarrierNumber).toBe(two.motorCarrierNumber);
  });

  it('leaves the clearance day out when the desk has nothing yet', () => {
    const draft = unwrap(readOnboardingRow(envelope, row({ insurance_cleared_on: '' }), 1));
    expect(draft.insuranceClearedOn).toBeUndefined();
  });

  it('treats the desk writing pending as nothing on file', () => {
    const draft = unwrap(readOnboardingRow(envelope, row({ insurance_cleared_on: 'n/a' }), 1));
    expect(draft.insuranceClearedOn).toBeUndefined();
  });

  it('rejects a clearance day that is not a day', () => {
    const r = readOnboardingRow(envelope, row({ insurance_cleared_on: 'next week' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('insurance_cleared_on');
    }
  });

  it('rejects a motor carrier number that is not one', () => {
    const r = readOnboardingRow(envelope, row({ mc_number: 'pending' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('mc_number');
    }
  });

  it('rejects a dot number that is not one', () => {
    const r = readOnboardingRow(envelope, row({ dot_number: 'none' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('dot_number');
    }
  });

  it('rejects an approval kind it does not know', () => {
    expect(isErr(readOnboardingRow(envelope, row({ approval_kind: 'provisional' }), 1))).toBe(true);
  });

  it('rejects a fractional power unit count', () => {
    expect(isErr(readOnboardingRow(envelope, row({ power_units: '2.5' }), 1))).toBe(true);
  });

  it('gathers every missing field in one pass', () => {
    const r = readOnboardingRow(envelope, { mc_number: '', dot_number: '', legal_name: '' }, 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems.length).toBeGreaterThan(3);
    }
  });

  it('keeps the code the carrier wrote on the packet', () => {
    expect(unwrap(readOnboardingRow(envelope, row(), 1)).referralCodeOnPacket).toBe('AB3K9ZQ');
  });

  it('stamps the row it came from', () => {
    expect(unwrap(readOnboardingRow(envelope, row(), 7)).sourceReference).toBe(
      'compliance/onboarding/42:7',
    );
  });
});

describe('readOnboardingFeed', () => {
  it('splits accepted from rejected', () => {
    const read = readOnboardingFeed(envelope, [row(), row({ approval_kind: 'provisional' })]);
    expect(read.accepted).toHaveLength(1);
    expect(read.rejected).toHaveLength(1);
  });
});

describe('awaitingInsurance', () => {
  it('finds the conditional packets with nothing on file', () => {
    const read = readOnboardingFeed(envelope, [
      row(),
      row({ insurance_cleared_on: '' }),
      row({ approval_kind: 'outright', insurance_cleared_on: '' }),
    ]);
    expect(awaitingInsurance(read)).toHaveLength(1);
  });
});
