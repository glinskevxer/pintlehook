import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/ingest/envelope.js';
import {
  LOAD_COLUMNS,
  deliveredDrafts,
  marginMinorOf,
  readLoadFeed,
  readLoadRow,
} from '../../src/ingest/loadFeed.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const envelope = unwrap(
  readEnvelope({
    source: 'tms',
    kind: 'load',
    cutAt: '2025-06-01T06:00:00Z',
    declaredRows: 1,
    zone: 'America/Chicago',
    sequence: 900,
  }),
);

function row(overrides: Record<string, string> = {}) {
  return {
    carrier_mc: 'MC-884210',
    pro_number: 'pl-449120',
    status: 'delivered',
    delivered_on: '2025-05-12',
    billed_on: '2025-05-15',
    origin_state: 'il',
    destination_state: 'tx',
    line_haul: '$2,850.00',
    carrier_pay: '2320.00',
    currency: 'usd',
    ...overrides,
  };
}

describe('columns', () => {
  it('names the eight that have to be there', () => {
    expect(LOAD_COLUMNS).toHaveLength(8);
  });
});

describe('readLoadRow', () => {
  it('reads a good row', () => {
    const draft = unwrap(readLoadRow(envelope, row(), 1));
    expect(draft.carrierMotorCarrierNumber).toBe('MC884210');
    expect(draft.proNumber).toBe('PL-449120');
    expect(draft.status).toBe('delivered');
    expect(draft.deliveredOn).toEqual(day(2025, 5, 12));
    expect(draft.billedOn).toEqual(day(2025, 5, 15));
    expect(draft.lane).toEqual({ originState: 'IL', destinationState: 'TX' });
    expect(draft.lineHaulMinor).toBe(285_000);
    expect(draft.carrierPayMinor).toBe(232_000);
    expect(draft.currency).toBe('USD');
  });

  it('leaves the delivery day out when nothing has delivered', () => {
    const draft = unwrap(
      readLoadRow(envelope, row({ status: 'in_transit', delivered_on: '', billed_on: '' }), 1),
    );
    expect(draft.deliveredOn).toBeUndefined();
    expect(draft.billedOn).toBeUndefined();
  });

  it('reads a bracketed negative carrier pay adjustment', () => {
    expect(unwrap(readLoadRow(envelope, row({ carrier_pay: '(50.00)' }), 1)).carrierPayMinor).toBe(
      -5000,
    );
  });

  it('rejects a status it does not know', () => {
    expect(isErr(readLoadRow(envelope, row({ status: 'tendered' }), 1))).toBe(true);
  });

  it('rejects money it cannot read', () => {
    const r = readLoadRow(envelope, row({ line_haul: 'see rate con' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('line_haul');
    }
  });

  it('rejects a currency we do not carry', () => {
    expect(isErr(readLoadRow(envelope, row({ currency: 'GBP' }), 1))).toBe(true);
  });

  it('rejects a delivery day that is not a day', () => {
    expect(isErr(readLoadRow(envelope, row({ delivered_on: 'last tuesday' }), 1))).toBe(true);
  });

  it('rejects a carrier number that is not one', () => {
    const r = readLoadRow(envelope, row({ carrier_mc: 'house' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('carrier_mc');
    }
  });

  it('gathers every problem in one pass', () => {
    const r = readLoadRow(envelope, row({ line_haul: 'x', carrier_pay: 'y', currency: 'z' }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems).toHaveLength(3);
    }
  });

  it('stamps the row it came from', () => {
    expect(unwrap(readLoadRow(envelope, row(), 12)).sourceReference).toBe('tms/load/900:12');
  });
});

describe('readLoadFeed', () => {
  it('splits accepted from rejected', () => {
    const read = readLoadFeed(envelope, [row(), row({ status: 'tendered' }), row()]);
    expect(read.accepted).toHaveLength(2);
    expect(read.rejected).toHaveLength(1);
  });
});

describe('deliveredDrafts', () => {
  it('keeps only what actually delivered', () => {
    const read = readLoadFeed(envelope, [
      row(),
      row({ status: 'cancelled', delivered_on: '', billed_on: '' }),
    ]);
    expect(deliveredDrafts(read)).toHaveLength(1);
  });
});

describe('marginMinorOf', () => {
  it('is the line haul less the carrier pay', () => {
    expect(marginMinorOf(unwrap(readLoadRow(envelope, row(), 1)))).toBe(53_000);
  });

  it('goes negative when the brokerage lost money', () => {
    const upsideDown = unwrap(readLoadRow(envelope, row({ carrier_pay: '3000.00' }), 1));
    expect(marginMinorOf(upsideDown)).toBe(-15_000);
  });
});
