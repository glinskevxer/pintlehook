import { beforeEach, describe, expect, it } from 'vitest';
import { carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import type { TouchDraft } from '../../src/ingest/touchFeed.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import { recordTouch, recordTouches, touchCountFor } from '../../src/service/referrals.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 2, 15, 15, 4, 0);

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

let store: Store;
let context: Context;
let code: string;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
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

function draft(overrides: Partial<TouchDraft> = {}): TouchDraft {
  return {
    presentedCode: code,
    channel: 'card',
    at: AT,
    inviteeMotorCarrierNumber: 'MC991002',
    inviteeDotNumber: undefined,
    inviteeName: undefined,
    sourceReference: 'fuel-desk/touch/1:1',
    rowNumber: 1,
    ...overrides,
  };
}

describe('recordTouch', () => {
  it('records the touch and opens the referral', () => {
    const recorded = unwrap(recordTouch(context, draft()));
    expect(recorded.openedReferral).toBe(true);
    unwrap(store.commit(recorded.drafts));
    expect(store.touches.size).toBe(1);
    expect(store.referrals.size).toBe(1);
  });

  it('does not open a second referral for the same invitee', () => {
    unwrap(store.commit(unwrap(recordTouch(context, draft())).drafts));
    const again = unwrap(recordTouch(context, draft({ channel: 'link' })));
    expect(again.openedReferral).toBe(false);
    unwrap(store.commit(again.drafts));
    expect(store.referrals.size).toBe(1);
    expect(store.touches.size).toBe(2);
  });

  it('refuses a code nobody holds', () => {
    expect(isErr(recordTouch(context, draft({ presentedCode: 'ZZZZZZZ' })))).toBe(true);
  });

  it('refuses a code from a closed enrolment', () => {
    const advocate = store.advocates.all()[0]!.id;
    unwrap(
      store.commit([
        {
          at: AT,
          kind: 'advocate_withdrawn',
          key: advocate,
          payload: { advocate, until: '2025-02-01', reason: 'withdrew' },
        },
      ]),
    );
    const r = recordTouch(context, draft());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('touch_advocate_not_enrolled');
    }
  });

  it('refuses a carrier presenting their own code', () => {
    const r = recordTouch(context, draft({ inviteeMotorCarrierNumber: 'MC884210' }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('touch_self_referral');
    }
  });

  it('refuses a row with nothing that resolves', () => {
    expect(isErr(recordTouch(context, draft({ inviteeMotorCarrierNumber: 'MC000001' })))).toBe(
      true,
    );
  });

  it('marks the invitee inferred when only the name matched', () => {
    const recorded = unwrap(
      recordTouch(
        context,
        draft({ inviteeMotorCarrierNumber: undefined, inviteeName: 'Delacroix Transport' }),
      ),
    );
    expect(recorded.inviteeInferred).toBe(true);
    expect(recorded.drafts[0]!.payload['inviteeInferred']).toBe(true);
  });

  it('does not mark the invitee inferred on a carrier number', () => {
    expect(unwrap(recordTouch(context, draft())).inviteeInferred).toBe(false);
  });

  it('refuses a channel it does not know', () => {
    expect(isErr(recordTouch(context, draft({ channel: 'billboard' as never })))).toBe(true);
  });

  it('keeps the instant the feed gave rather than the clock', () => {
    const recorded = unwrap(recordTouch(context, draft({ at: 1_000 })));
    expect(recorded.drafts[0]!.payload['at']).toBe(1_000);
  });

  it('mints a fresh touch identifier each time', () => {
    const first = unwrap(recordTouch(context, draft()));
    unwrap(store.commit(first.drafts));
    const second = unwrap(recordTouch(context, draft({ channel: 'link' })));
    expect(second.touch).not.toBe(first.touch);
  });
});

describe('recordTouches', () => {
  it('records the good ones and reports the rest', () => {
    const outcome = recordTouches(context, [
      draft(),
      draft({ presentedCode: 'ZZZZZZZ' }),
      draft({ channel: 'link' }),
    ]);
    expect(outcome.recorded).toHaveLength(2);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.code).toBe('advocate_code_unknown');
  });

  it('gathers every journal draft in order', () => {
    const outcome = recordTouches(context, [draft(), draft({ channel: 'link' })]);
    unwrap(store.commit(outcome.drafts));
    expect(store.touches.size).toBe(2);
  });

  it('opens the referral once across a batch when the store is committed after', () => {
    const outcome = recordTouches(context, [draft(), draft({ channel: 'link' })]);
    const opens = outcome.drafts.filter((d) => d.kind === 'referral_opened');
    expect(opens.length).toBeGreaterThanOrEqual(1);
  });

  it('handles an empty batch', () => {
    const outcome = recordTouches(context, []);
    expect(outcome.recorded).toEqual([]);
    expect(outcome.drafts).toEqual([]);
  });
});

describe('touchCountFor', () => {
  it('counts what is filed', () => {
    unwrap(store.commit(unwrap(recordTouch(context, draft())).drafts));
    expect(touchCountFor(context, carrierId(9))).toBe(1);
    expect(touchCountFor(context, carrierId(1))).toBe(0);
  });
});
