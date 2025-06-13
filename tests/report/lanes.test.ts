import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import {
  advocateLanes,
  laneReport,
  lanesForCarrier,
  lanesForInvitees,
  overlapOf,
} from '../../src/report/lanes.js';
import { renderText } from '../../src/report/table.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

function carrier(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'carrier_filed',
    key: carrierId(id),
    payload: {
      carrier: carrierId(id),
      legalName: `Carrier ${id}`,
      motorCarrierNumber: `MC90000${id}`,
      dotNumber: `550000${id}`,
      authorityStatus: 'active',
      remitDigest: `r${id}`,
      bankDigest: `b${id}`,
      powerUnits: 1,
    },
  };
}

const enrolled: JournalDraft = {
  at: AT,
  kind: 'advocate_enrolled',
  key: advocateId(1),
  payload: {
    advocate: advocateId(1),
    carrier: carrierId(1),
    program: programId(1),
    referralCode: 'AB3K9ZQ',
    from: '2025-01-01',
  },
};

function referral(invitee: number): JournalDraft[] {
  const key = `prg_00000001:${carrierId(invitee)}`;
  return [
    {
      at: AT,
      kind: 'referral_opened',
      key,
      payload: { program: programId(1), invitee: carrierId(invitee), recordedOn: '2025-01-05' },
    },
    {
      at: AT,
      kind: 'referral_attributed',
      key,
      payload: {
        program: programId(1),
        invitee: carrierId(invitee),
        advocate: advocateId(1),
        effectiveActivation: '2025-02-01',
      },
    },
  ];
}

function load(
  seq: number,
  cxr: number,
  from: string,
  to: string,
  marginMinor: number,
): JournalDraft {
  return {
    at: AT,
    kind: 'load_delivered',
    key: `lod_${seq}`,
    payload: {
      load: `lod_${seq}`,
      carrier: carrierId(cxr),
      proNumber: `PL-${seq}`,
      deliveredOn: '2025-03-10',
      lineHaulMinor: 200_000 + marginMinor,
      carrierPayMinor: 200_000,
      currency: 'USD',
      originState: from,
      destinationState: to,
    },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'analyst'));
  unwrap(store.commit([carrier(1), carrier(9), carrier(8), enrolled]));
});

describe('lanesForCarrier', () => {
  it('groups the delivered loads by lane', () => {
    unwrap(
      store.commit([
        load(1, 9, 'IL', 'TX', 50_000),
        load(2, 9, 'IL', 'TX', 30_000),
        load(3, 9, 'TX', 'IL', 20_000),
      ]),
    );
    const rows = unwrap(lanesForCarrier(context, carrierId(9), 'USD'));
    expect(rows.map((row) => row.lane)).toEqual(['IL-TX', 'TX-IL']);
    expect(rows[0]!.loads).toBe(2);
    expect(rows[0]!.margin.minor).toBe(80_000);
  });

  it('averages the margin per load', () => {
    unwrap(store.commit([load(1, 9, 'IL', 'TX', 50_000), load(2, 9, 'IL', 'TX', 31_000)]));
    expect(unwrap(lanesForCarrier(context, carrierId(9), 'USD'))[0]!.averageMargin.minor).toBe(
      40_500,
    );
  });

  it('keeps the two directions of a lane apart', () => {
    unwrap(store.commit([load(1, 9, 'IL', 'TX', 10_000), load(2, 9, 'TX', 'IL', 10_000)]));
    expect(unwrap(lanesForCarrier(context, carrierId(9), 'USD'))).toHaveLength(2);
  });

  it('leaves out a load that was not delivered', () => {
    unwrap(
      store.commit([
        load(1, 9, 'IL', 'TX', 10_000),
        {
          at: AT,
          kind: 'load_amended',
          key: 'lod_1',
          payload: { load: 'lod_1', field: 'status', value: 'cancelled' },
        },
      ]),
    );
    expect(unwrap(lanesForCarrier(context, carrierId(9), 'USD'))).toEqual([]);
  });

  it('gives nothing for a carrier that has hauled nothing', () => {
    expect(unwrap(lanesForCarrier(context, carrierId(8), 'USD'))).toEqual([]);
  });
});

describe('lanesForInvitees', () => {
  it('adds every invited carrier of an advocate together', () => {
    unwrap(
      store.commit([
        ...referral(9),
        ...referral(8),
        load(1, 9, 'IL', 'TX', 50_000),
        load(2, 8, 'IL', 'TX', 30_000),
        load(3, 8, 'OH', 'PA', 10_000),
      ]),
    );
    const rows = unwrap(lanesForInvitees(context, advocateId(1), programId(1), 'USD'));
    expect(rows.map((row) => row.lane)).toEqual(['IL-TX', 'OH-PA']);
    expect(rows[0]!.loads).toBe(2);
    expect(rows[0]!.margin.minor).toBe(80_000);
  });

  it('leaves out referrals on another program', () => {
    unwrap(store.commit([...referral(9), load(1, 9, 'IL', 'TX', 50_000)]));
    expect(unwrap(lanesForInvitees(context, advocateId(1), programId(2), 'USD'))).toEqual([]);
  });

  it('gives nothing for an advocate with no referrals', () => {
    expect(unwrap(lanesForInvitees(context, advocateId(9), programId(1), 'USD'))).toEqual([]);
  });
});

describe('advocateLanes', () => {
  it('reads the lanes the advocate runs themselves', () => {
    unwrap(store.commit([load(1, 1, 'IL', 'TX', 50_000)]));
    expect(unwrap(advocateLanes(context, advocateId(1), 'USD'))[0]!.lane).toBe('IL-TX');
  });

  it('fails for an advocate nobody enrolled', () => {
    expect(isErr(advocateLanes(context, advocateId(9), 'USD'))).toBe(true);
  });
});

describe('overlapOf', () => {
  it('splits shared lanes from new ones', () => {
    unwrap(
      store.commit([
        ...referral(9),
        load(1, 1, 'IL', 'TX', 10_000),
        load(2, 9, 'IL', 'TX', 10_000),
        load(3, 9, 'OH', 'PA', 10_000),
      ]),
    );
    const mine = unwrap(advocateLanes(context, advocateId(1), 'USD'));
    const theirs = unwrap(lanesForInvitees(context, advocateId(1), programId(1), 'USD'));
    const overlap = overlapOf(mine, theirs);
    expect(overlap.shared).toEqual(['IL-TX']);
    expect(overlap.newLanes).toEqual(['OH-PA']);
    expect(overlap.overlapShare).toBeCloseTo(0.5);
  });

  it('is all new when the advocate runs nothing', () => {
    const overlap = overlapOf(
      [],
      [
        {
          lane: 'IL-TX',
          loads: 1,
          margin: { currency: 'USD', minor: 1 },
          averageMargin: { currency: 'USD', minor: 1 },
        },
      ],
    );
    expect(overlap.overlapShare).toBe(0);
    expect(overlap.newLanes).toEqual(['IL-TX']);
  });

  it('is zero rather than dividing by nothing when both sides are empty', () => {
    expect(overlapOf([], []).overlapShare).toBe(0);
  });
});

describe('laneReport', () => {
  it('carries the lane, the count and both money columns', () => {
    unwrap(store.commit([load(1, 9, 'IL', 'TX', 50_000)]));
    const rows = unwrap(lanesForCarrier(context, carrierId(9), 'USD'));
    const report = laneReport(rows, 'lanes for cxr_00000009', 'USD');
    expect(report.columns.map((column) => column.key)).toEqual([
      'lane',
      'loads',
      'margin',
      'average',
    ]);
    expect(renderText(report)).toContain('IL-TX');
    expect(report.footnotes[0]).toContain('50000');
  });
});
