import { beforeEach, describe, expect, it } from 'vitest';
import { carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import type { ClaimDraft } from '../../src/ingest/claimFeed.js';
import type { LoadDraft } from '../../src/ingest/loadFeed.js';
import type { TouchDraft } from '../../src/ingest/touchFeed.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import {
  applyClaims,
  applyLoads,
  applyTouches,
  commitAll,
  reportOf,
} from '../../src/service/ingestService.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 1, 12, 0, 0);

function party(id: number, name: string, mc: string, dot: string): Party {
  return {
    id: carrierId(id),
    legalName: name,
    motorCarrierNumber: mc,
    dotNumber: dot,
    authorityStatus: 'active',
    remit: { line1: `${id} Main St`, city: 'Joliet', state: 'IL', postalCode: '60431' },
    bank: undefined,
    powerUnits: 1,
  };
}

function loadDraft(overrides: Partial<LoadDraft> = {}): LoadDraft {
  return {
    carrierMotorCarrierNumber: 'MC991002',
    proNumber: 'PL-449120',
    status: 'delivered',
    deliveredOn: day(2025, 5, 12),
    billedOn: undefined,
    lane: { originState: 'IL', destinationState: 'TX' },
    lineHaulMinor: 285_000,
    carrierPayMinor: 232_000,
    currency: 'USD',
    sourceReference: 'tms/load/1:1',
    rowNumber: 1,
    ...overrides,
  };
}

function claimDraft(overrides: Partial<ClaimDraft> = {}): ClaimDraft {
  return {
    administratorReference: 'CLM-8841',
    proNumber: 'PL-449120',
    raisedOn: day(2025, 6, 1),
    disposition: 'charged_to_carrier',
    amountMinor: 150_000,
    currency: 'USD',
    closedOn: undefined,
    sourceReference: 'claims/claim/1:1',
    rowNumber: 1,
    ...overrides,
  };
}

let store: Store;
let context: Context;
let code: string;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'ingest'));
  unwrap(
    store.commit(unwrap(fileCarrier(context, party(1, 'Brannan Hauling', 'MC884210', '3126540')))),
  );
  unwrap(
    store.commit(
      unwrap(fileCarrier(context, party(9, 'Delacroix Transport', 'MC991002', '4410781'))),
    ),
  );
  const enrolled = unwrap(
    enrolAdvocate(context, { carrier: carrierId(1), program: programId(1), from: day(2025, 1, 1) }),
  );
  unwrap(store.commit(enrolled.drafts));
  code = enrolled.referralCode;
});

describe('applyLoads', () => {
  it('files a delivered load against the carrier it resolved', () => {
    const outcome = unwrap(applyLoads(context, [loadDraft()]));
    unwrap(commitAll(context, outcome.drafts));
    const row = store.loads.all()[0]!;
    expect(row.carrier).toBe(carrierId(9));
    expect(row.proNumber).toBe('PL-449120');
    expect(row.deliveredOn).toBe('2025-05-12');
  });

  it('reports a carrier it cannot resolve rather than guessing', () => {
    const outcome = unwrap(
      applyLoads(context, [loadDraft({ carrierMotorCarrierNumber: 'MC000001' })]),
    );
    expect(outcome.drafts).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]!.reference).toBe('tms/load/1:1');
  });

  it('files nothing for a load that has not delivered', () => {
    const outcome = unwrap(
      applyLoads(context, [loadDraft({ status: 'in_transit', deliveredOn: undefined })]),
    );
    expect(outcome.accepted).toBe(0);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('mints a fresh identifier per load', () => {
    const outcome = unwrap(
      applyLoads(context, [loadDraft(), loadDraft({ proNumber: 'PL-449121' })]),
    );
    const ids = outcome.drafts.map((draft) => draft.payload['load']);
    expect(new Set(ids).size).toBe(2);
  });

  it('carries the feed row reference onto the record', () => {
    const outcome = unwrap(applyLoads(context, [loadDraft()]));
    expect(outcome.drafts[0]!.payload['sourceReference']).toBe('tms/load/1:1');
  });
});

describe('applyClaims', () => {
  beforeEach(() => {
    unwrap(commitAll(context, unwrap(applyLoads(context, [loadDraft()])).drafts));
  });

  it('files a claim against the load carrying the pro number', () => {
    const outcome = unwrap(applyClaims(context, [claimDraft()]));
    unwrap(commitAll(context, outcome.drafts));
    const row = store.claims.all()[0]!;
    expect(row.load).toBe(store.loads.all()[0]!.id);
    expect(row.disposition).toBe('charged_to_carrier');
  });

  it('reports a pro number nothing matches', () => {
    const outcome = unwrap(applyClaims(context, [claimDraft({ proNumber: 'PL-000000' })]));
    expect(outcome.drafts).toHaveLength(0);
    expect(outcome.unresolved[0]!.code).toBe('claim_load_unknown');
  });

  it('keeps the administrator reference on the record', () => {
    const outcome = unwrap(applyClaims(context, [claimDraft()]));
    expect(outcome.drafts[0]!.payload['administratorReference']).toBe('CLM-8841');
  });
});

describe('applyTouches', () => {
  it('records the good ones and reports the rest', () => {
    const good: TouchDraft = {
      presentedCode: code,
      channel: 'card',
      at: AT,
      inviteeMotorCarrierNumber: 'MC991002',
      inviteeDotNumber: undefined,
      inviteeName: undefined,
      sourceReference: 'fuel/touch/1:1',
      rowNumber: 1,
    };
    const outcome = applyTouches(context, [good, { ...good, presentedCode: 'ZZZZZZZ' }]);
    expect(outcome.recorded).toHaveLength(1);
    expect(outcome.rejected).toHaveLength(1);
    unwrap(commitAll(context, outcome.drafts));
    expect(store.touches.size).toBe(1);
  });
});

describe('commitAll', () => {
  it('writes nothing for an empty list', () => {
    expect(unwrap(commitAll(context, []))).toBe(0);
    expect(store.sequence).toBe(3);
  });

  it('reports how many records it wrote', () => {
    const outcome = unwrap(applyLoads(context, [loadDraft(), loadDraft({ proNumber: 'PL-2' })]));
    expect(unwrap(commitAll(context, outcome.drafts))).toBe(2);
  });
});

describe('reportOf', () => {
  it('counts what happened to a delivery', () => {
    const outcome = unwrap(
      applyLoads(context, [loadDraft(), loadDraft({ carrierMotorCarrierNumber: 'MC000001' })]),
    );
    expect(reportOf(outcome, [])).toEqual({ applied: 1, unresolved: 1, quarantined: 0 });
  });
});
