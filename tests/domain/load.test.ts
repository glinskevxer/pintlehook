import { describe, expect, it } from 'vitest';
import { carrierId, loadId } from '../../src/domain/identity.js';
import {
  describeLoad,
  grossMargin,
  isDelivered,
  isInterstate,
  laneKey,
  loadNaturalKey,
  loadOrder,
  marginIsNegative,
  validateLoad,
  type Load,
} from '../../src/domain/load.js';
import { day } from '../../src/util/clock.js';
import { sorted } from '../../src/util/ordering.js';
import { isErr, unwrap } from '../../src/util/result.js';

const load: Load = {
  id: loadId(1),
  carrier: carrierId(9),
  status: 'delivered',
  deliveredOn: day(2025, 5, 12),
  billedOn: day(2025, 5, 15),
  lane: { originState: 'IL', destinationState: 'TX' },
  lineHaulMinor: 285_000,
  carrierPayMinor: 232_000,
  currency: 'USD',
  proNumber: 'PL-449120',
};

describe('isDelivered', () => {
  it('needs both the status and the day', () => {
    expect(isDelivered(load)).toBe(true);
    expect(isDelivered({ ...load, status: 'in_transit', deliveredOn: undefined })).toBe(false);
  });
});

describe('grossMargin', () => {
  it('is the line haul less the carrier pay', () => {
    expect(grossMargin(load).minor).toBe(53_000);
    expect(grossMargin(load).currency).toBe('USD');
  });

  it('goes negative when the brokerage lost money', () => {
    const upsideDown: Load = { ...load, carrierPayMinor: 300_000 };
    expect(grossMargin(upsideDown).minor).toBe(-15_000);
    expect(marginIsNegative(upsideDown)).toBe(true);
    expect(marginIsNegative(load)).toBe(false);
  });
});

describe('lanes', () => {
  it('separates interstate from intrastate', () => {
    expect(isInterstate(load)).toBe(true);
    expect(isInterstate({ ...load, lane: { originState: 'IL', destinationState: 'IL' } })).toBe(
      false,
    );
  });

  it('keys a lane in one direction only', () => {
    expect(laneKey(load.lane)).toBe('IL-TX');
    expect(laneKey({ originState: 'TX', destinationState: 'IL' })).toBe('TX-IL');
  });
});

describe('loadNaturalKey', () => {
  it('ignores the surrogate identifier', () => {
    expect(loadNaturalKey({ ...load, id: loadId(88) })).toBe(loadNaturalKey(load));
  });

  it('collapses casing and stray spaces in the pro number', () => {
    expect(loadNaturalKey({ ...load, proNumber: ' pl-449120 ' })).toBe(loadNaturalKey(load));
  });

  it('separates the same pro number under two carriers', () => {
    expect(loadNaturalKey({ ...load, carrier: carrierId(10) })).not.toBe(loadNaturalKey(load));
  });
});

describe('loadOrder', () => {
  it('puts undelivered loads first', () => {
    const pending: Load = {
      ...load,
      id: loadId(2),
      status: 'in_transit',
      deliveredOn: undefined,
      proNumber: 'PL-000001',
    };
    expect(sorted([load, pending], loadOrder)[0]!.id).toBe(pending.id);
  });

  it('orders delivered loads by delivery day', () => {
    const later: Load = { ...load, id: loadId(2), deliveredOn: day(2025, 6, 1) };
    expect(sorted([later, load], loadOrder)[0]!.id).toBe(load.id);
  });

  it('breaks a tie on the pro number', () => {
    const other: Load = { ...load, id: loadId(2), proNumber: 'PL-000001' };
    expect(sorted([load, other], loadOrder)[0]!.proNumber).toBe('PL-000001');
  });
});

describe('validateLoad', () => {
  it('accepts a good load', () => {
    expect(unwrap(validateLoad(load))).toEqual(load);
  });

  it('rejects a missing pro number', () => {
    expect(isErr(validateLoad({ ...load, proNumber: '  ' }))).toBe(true);
  });

  it('rejects a fractional amount', () => {
    expect(isErr(validateLoad({ ...load, lineHaulMinor: 100.5 }))).toBe(true);
  });

  it('rejects a negative amount', () => {
    const r = validateLoad({ ...load, carrierPayMinor: -1 });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('load_amount_negative');
    }
  });

  it('allows a negative margin, which happens', () => {
    expect(isErr(validateLoad({ ...load, carrierPayMinor: 999_999 }))).toBe(false);
  });

  it('rejects a lane that is not two state codes', () => {
    expect(
      isErr(validateLoad({ ...load, lane: { originState: 'Illinois', destinationState: 'TX' } })),
    ).toBe(true);
  });

  it('rejects a delivered load with no delivery day', () => {
    const r = validateLoad({ ...load, deliveredOn: undefined });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('load_delivered_without_day');
    }
  });

  it('rejects a cancelled load that carries a delivery day', () => {
    const r = validateLoad({ ...load, status: 'cancelled' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('load_undelivered_with_day');
    }
  });

  it('rejects a bill dated before the delivery', () => {
    const r = validateLoad({ ...load, billedOn: day(2025, 5, 1) });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('load_billed_before_delivery');
    }
  });

  it('allows a delivered load that has not been billed yet', () => {
    expect(isErr(validateLoad({ ...load, billedOn: undefined }))).toBe(false);
  });
});

describe('describeLoad', () => {
  it('reads back the way the load board prints it', () => {
    expect(describeLoad(load)).toBe('PL-449120 IL-TX delivered');
  });
});
