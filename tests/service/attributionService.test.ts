import { beforeEach, describe, expect, it } from 'vitest';
import { carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import type { TouchDraft } from '../../src/ingest/touchFeed.js';
import {
  attributeReferral,
  attributionDrafts,
  consideredCount,
  screenedTouchIds,
} from '../../src/service/attributionService.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import { recordTouch } from '../../src/service/referrals.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 1, 12, 0, 0);
const ACTIVATION = day(2025, 4, 10);

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 3,
  qualifyingWindowDays: 120,
  retentionDays: 180,
  programYearCapMinor: 0,
  releaseCeilingMinor: 100_000,
  currency: 'USD',
};

const schedule: RewardSchedule = {
  currency: 'USD',
  tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 }],
};

function catalogWithWindow(days: number) {
  const program: Program = {
    id: programId(1),
    name: 'referral',
    openedOn: day(2024, 1, 1),
    versions: [
      {
        version: 1,
        effectiveFrom: day(2024, 1, 1),
        rules: { ...rules, attributionWindowDays: days },
        note: 'x',
      },
    ],
  };
  return unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
}

const catalog = catalogWithWindow(90);

function party(id: number, name: string, mc: string, dot: string, line1 = `${id} Main St`): Party {
  return {
    id: carrierId(id),
    legalName: name,
    motorCarrierNumber: mc,
    dotNumber: dot,
    authorityStatus: 'active',
    remit: { line1, city: 'Joliet', state: 'IL', postalCode: '60431' },
    bank: undefined,
    powerUnits: 1,
  };
}

let store: Store;
let context: Context;
const codes = new Map<number, string>();

function draftFor(
  carrier: number,
  at: number,
  channel: TouchDraft['channel'] = 'card',
): TouchDraft {
  return {
    presentedCode: codes.get(carrier) as string,
    channel,
    at,
    inviteeMotorCarrierNumber: 'MC991002',
    inviteeDotNumber: undefined,
    inviteeName: undefined,
    sourceReference: 'fuel-desk/touch/1:1',
    rowNumber: 1,
  };
}

function record(carrier: number, at: number, channel: TouchDraft['channel'] = 'card') {
  unwrap(store.commit(unwrap(recordTouch(context, draftFor(carrier, at, channel))).drafts));
}

function attribute(cat = catalog) {
  return unwrap(
    attributeReferral(context, cat, {
      program: programId(1),
      invitee: carrierId(9),
      effectiveActivation: ACTIVATION,
    }),
  );
}

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  codes.clear();
  for (const [id, name, mc, dot] of [
    [1, 'Brannan Hauling', 'MC884210', '3126540'],
    [2, 'Cobb Transport', 'MC700055', '5500123'],
    [9, 'Delacroix Transport', 'MC991002', '4410781'],
  ] as const) {
    unwrap(store.commit(unwrap(fileCarrier(context, party(id, name, mc, dot)))));
  }
  for (const id of [1, 2]) {
    const enrolled = unwrap(
      enrolAdvocate(context, {
        carrier: carrierId(id),
        program: programId(1),
        from: day(2025, 1, 1),
      }),
    );
    unwrap(store.commit(enrolled.drafts));
    codes.set(id, enrolled.referralCode);
  }
});

describe('attributeReferral', () => {
  it('credits the latest touch inside the window', () => {
    record(1, Date.UTC(2025, 2, 1, 15));
    record(2, Date.UTC(2025, 3, 1, 15));
    const outcome = attribute();
    expect(outcome.credited).toBe(true);
    if (outcome.credited) {
      expect(store.advocates.get(outcome.advocate)!.carrier).toBe(carrierId(2));
    }
  });

  it('leaves a touch outside the window uncredited', () => {
    record(1, Date.UTC(2024, 11, 1, 15));
    const outcome = attribute();
    expect(outcome.credited).toBe(false);
    if (!outcome.credited) {
      expect(outcome.reason).toBe('all_outside_window');
    }
  });

  it('moves the credit when the window narrows', () => {
    record(1, Date.UTC(2025, 1, 1, 15));
    record(2, Date.UTC(2025, 3, 5, 15));
    expect(attribute(catalogWithWindow(90)).credited).toBe(true);
    expect(attribute(catalogWithWindow(3)).credited).toBe(false);
  });

  it('breaks a same instant tie on channel strength', () => {
    const at = Date.UTC(2025, 3, 1, 15);
    record(1, at, 'packet');
    record(2, at, 'link');
    const outcome = attribute();
    if (outcome.credited) {
      expect(store.advocates.get(outcome.advocate)!.carrier).toBe(carrierId(1));
    }
  });

  it('reports nothing on file as no touches', () => {
    const outcome = attribute();
    expect(outcome.credited).toBe(false);
    if (!outcome.credited) {
      expect(outcome.reason).toBe('no_touches');
    }
  });

  it('fails for a program the catalogue does not hold', () => {
    expect(
      isErr(
        attributeReferral(context, catalog, {
          program: programId(9),
          invitee: carrierId(9),
          effectiveActivation: ACTIVATION,
        }),
      ),
    ).toBe(true);
  });

  it('counts every touch it considered', () => {
    record(1, Date.UTC(2025, 2, 1, 15));
    record(2, Date.UTC(2025, 3, 1, 15));
    expect(consideredCount(attribute())).toBe(2);
  });

  it('screens nothing when the advocates are unrelated to the invitee', () => {
    record(1, Date.UTC(2025, 3, 1, 15));
    expect(screenedTouchIds(attribute())).toHaveLength(0);
  });
});

describe('attributionDrafts', () => {
  const request = {
    program: programId(1),
    invitee: carrierId(9),
    effectiveActivation: ACTIVATION,
  };

  it('writes the attribution with the winning touch on it', () => {
    record(1, Date.UTC(2025, 3, 1, 15));
    const drafts = unwrap(attributionDrafts(context, request, attribute()));
    expect(drafts[0]!.payload['effectiveActivation']).toBe('2025-04-10');
    expect(drafts[0]!.payload['channel']).toBe('card');
    unwrap(store.commit(drafts));
    expect(store.referrals.get('prg_00000001:cxr_00000009')!.state).toBe('attributed');
  });

  it('writes nothing when nothing was credited', () => {
    const r = attributionDrafts(context, request, attribute());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('attribution_uncredited');
    }
  });
});
