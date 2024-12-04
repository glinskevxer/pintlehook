import { describe, expect, it } from 'vitest';
import {
  CLAIM_COLUMNS,
  chargedDrafts,
  latestPerClaim,
  readClaimFeed,
  readClaimRow,
} from '../../src/ingest/claimFeed.js';
import { readEnvelope } from '../../src/ingest/envelope.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const envelope = unwrap(
  readEnvelope({
    source: 'claims-admin',
    kind: 'claim',
    cutAt: '2025-06-01T06:00:00Z',
    declaredRows: 1,
    zone: 'UTC',
    sequence: 12,
  }),
);

function row(overrides: Record<string, string> = {}) {
  return {
    claim_reference: 'clm-8841',
    pro_number: 'pl-449120',
    raised_on: '2025-03-01',
    disposition: 'charged to carrier',
    amount: '1,500.00',
    currency: 'USD',
    closed_on: '',
    ...overrides,
  };
}

describe('columns', () => {
  it('names the six that have to be there', () => {
    expect(CLAIM_COLUMNS).toHaveLength(6);
  });
});

describe('readClaimRow', () => {
  it('reads a good row', () => {
    const draft = unwrap(readClaimRow(envelope, row(), 1));
    expect(draft.administratorReference).toBe('CLM-8841');
    expect(draft.proNumber).toBe('PL-449120');
    expect(draft.raisedOn).toEqual(day(2025, 3, 1));
    expect(draft.disposition).toBe('charged_to_carrier');
    expect(draft.amountMinor).toBe(150_000);
    expect(draft.closedOn).toBeUndefined();
  });

  it('reads every disposition the administrator writes', () => {
    for (const [written, expected] of [
      ['charged to carrier', 'charged_to_carrier'],
      ['Absorbed', 'absorbed'],
      ['denied', 'denied'],
      ['open', 'open'],
    ] as const) {
      expect(unwrap(readClaimRow(envelope, row({ disposition: written }), 1)).disposition).toBe(
        expected,
      );
    }
  });

  it('reads a closing day when the claim is settled', () => {
    expect(unwrap(readClaimRow(envelope, row({ closed_on: '2025-04-01' }), 1)).closedOn).toEqual(
      day(2025, 4, 1),
    );
  });

  it('rejects a negative claim', () => {
    const r = readClaimRow(envelope, row({ amount: '(100.00)' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('claim_amount_negative');
    }
  });

  it('accepts a claim of nothing, which the administrator uses to open a file', () => {
    expect(unwrap(readClaimRow(envelope, row({ amount: '0' }), 1)).amountMinor).toBe(0);
  });

  it('rejects a disposition it does not know', () => {
    expect(isErr(readClaimRow(envelope, row({ disposition: 'in review' }), 1))).toBe(true);
  });

  it('rejects a closing day that is not a day', () => {
    expect(isErr(readClaimRow(envelope, row({ closed_on: 'when it closes' }), 1))).toBe(true);
  });

  it('gathers every problem in one pass', () => {
    const r = readClaimRow(envelope, row({ amount: 'x', currency: 'y', raised_on: 'z' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems).toHaveLength(3);
    }
  });
});

describe('readClaimFeed', () => {
  it('splits accepted from rejected', () => {
    const read = readClaimFeed(envelope, [row(), row({ disposition: 'in review' })]);
    expect(read.accepted).toHaveLength(1);
    expect(read.rejected).toHaveLength(1);
  });
});

describe('latestPerClaim', () => {
  it('keeps the last statement about a claim', () => {
    const read = readClaimFeed(envelope, [
      row({ disposition: 'open' }),
      row({ disposition: 'charged to carrier' }),
    ]);
    const latest = latestPerClaim(read.accepted);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.disposition).toBe('charged_to_carrier');
  });

  it('keeps two different claims apart', () => {
    const read = readClaimFeed(envelope, [row(), row({ claim_reference: 'clm-9000' })]);
    expect(latestPerClaim(read.accepted)).toHaveLength(2);
  });

  it('orders by reference so the result is repeatable', () => {
    const read = readClaimFeed(envelope, [
      row({ claim_reference: 'clm-z' }),
      row({ claim_reference: 'clm-a' }),
    ]);
    expect(latestPerClaim(read.accepted).map((d) => d.administratorReference)).toEqual([
      'CLM-A',
      'CLM-Z',
    ]);
  });

  it('handles an empty list', () => {
    expect(latestPerClaim([])).toEqual([]);
  });
});

describe('chargedDrafts', () => {
  it('keeps only the ones charged to the carrier', () => {
    const read = readClaimFeed(envelope, [row(), row({ disposition: 'absorbed' })]);
    expect(chargedDrafts(read)).toHaveLength(1);
  });
});
