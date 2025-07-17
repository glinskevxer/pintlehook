import { beforeEach, describe, expect, it } from 'vitest';
import { draftFrom, inviteeOf, programOf, referralRoutes } from '../../src/api/referrals.js';
import { Router, request } from '../../src/api/router.js';
import { carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

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

let store: Store;
let context: Context;
let catalog: Catalog;
let router: Router;
let code: string;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'partner'));
  catalog = unwrap(buildCatalog([], []));
  router = new Router().addAll(referralRoutes);
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

function post(path: string, body: Record<string, unknown>) {
  return router.handle(context, catalog, request({ method: 'post', path, body, actor: 'partner' }));
}

function get(path: string, query: Record<string, string> = {}) {
  return router.handle(context, catalog, request({ path, query }));
}

function touchBody(overrides: Record<string, unknown> = {}) {
  return {
    referralCode: code,
    channel: 'card',
    occurredAt: '2025-03-15T15:04:00Z',
    inviteeMotorCarrierNumber: 'MC991002',
    ...overrides,
  };
}

describe('draftFrom', () => {
  it('reads a good body', () => {
    const draft = unwrap(draftFrom(request({ body: touchBody(), actor: 'partner' })));
    expect(draft.presentedCode).toBe(code);
    expect(draft.channel).toBe('card');
    expect(draft.at).toBe(Date.UTC(2025, 2, 15, 15, 4, 0));
  });

  it('stamps a source reference naming the caller when none was given', () => {
    const draft = unwrap(draftFrom(request({ body: touchBody(), actor: 'partner' })));
    expect(draft.sourceReference).toBe('api/partner');
  });

  it('keeps a source reference the caller gave', () => {
    const draft = unwrap(
      draftFrom(request({ body: touchBody({ sourceReference: 'their-system:41' }) })),
    );
    expect(draft.sourceReference).toBe('their-system:41');
  });

  it('refuses a missing field and names it', () => {
    const r = draftFrom(request({ body: touchBody({ channel: '' }) }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('channel');
    }
  });

  it('refuses a channel it does not know', () => {
    expect(isErr(draftFrom(request({ body: touchBody({ channel: 'billboard' }) })))).toBe(true);
  });

  it('refuses an instant with no zone', () => {
    expect(
      isErr(draftFrom(request({ body: touchBody({ occurredAt: '2025-03-15 15:04:00' }) }))),
    ).toBe(true);
  });
});

describe('posting a touch', () => {
  it('records it and opens the referral', () => {
    const response = post('/touches', touchBody());
    expect(response.status).toBe(201);
    const body = response.body as { openedReferral: boolean; invitee: string };
    expect(body.openedReferral).toBe(true);
    expect(body.invitee).toBe(carrierId(9));
    expect(store.touches.size).toBe(1);
  });

  it('takes the same screens a feed row takes', () => {
    const response = post('/touches', touchBody({ inviteeMotorCarrierNumber: 'MC884210' }));
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe('touch_self_referral');
  });

  it('answers not found for a code nobody holds', () => {
    expect(post('/touches', touchBody({ referralCode: 'ZZZZZZZ' })).status).toBe(404);
  });

  it('says when the invitee was only matched on a name', () => {
    const response = post(
      '/touches',
      touchBody({ inviteeMotorCarrierNumber: undefined, inviteeName: 'Delacroix Transport' }),
    );
    expect((response.body as { inviteeInferred: boolean }).inviteeInferred).toBe(true);
  });

  it('does not open a second referral on the second touch', () => {
    post('/touches', touchBody());
    const again = post('/touches', touchBody({ channel: 'link' }));
    expect((again.body as { openedReferral: boolean }).openedReferral).toBe(false);
    expect(store.referrals.size).toBe(1);
  });
});

describe('reading a referral', () => {
  it('answers the days it carries, with nulls where there are none', () => {
    post('/touches', touchBody());
    const body = get(`/referrals/${programId(1)}/${carrierId(9)}`).body as {
      state: string;
      qualifiedOn: string | null;
      advocate: string | null;
    };
    expect(body.state).toBe('recorded');
    expect(body.qualifiedOn).toBeNull();
    expect(body.advocate).toBeNull();
  });

  it('answers not found for a referral nobody opened', () => {
    expect(get(`/referrals/${programId(1)}/${carrierId(8)}`).status).toBe(404);
  });

  it('answers a bad request for identifiers of the wrong kind', () => {
    expect(get(`/referrals/${carrierId(1)}/${carrierId(9)}`).status).toBe(400);
  });
});

describe('listing referrals', () => {
  it('needs a state', () => {
    const response = get('/referrals');
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe('query_missing');
  });

  it('lists what is in that state', () => {
    post('/touches', touchBody());
    const body = get('/referrals', { state: 'recorded' }).body as unknown[];
    expect(body).toHaveLength(1);
  });

  it('filters to one program when asked', () => {
    post('/touches', touchBody());
    expect(get('/referrals', { state: 'recorded', program: programId(2) }).body).toEqual([]);
  });

  it('answers an empty list for a state with nothing in it', () => {
    expect(get('/referrals', { state: 'qualified' }).body).toEqual([]);
  });
});

describe('listing touches', () => {
  it('lists them in time order', () => {
    post('/touches', touchBody({ occurredAt: '2025-03-16T15:04:00Z' }));
    post('/touches', touchBody({ occurredAt: '2025-03-15T15:04:00Z', channel: 'link' }));
    const body = get(`/carriers/${carrierId(9)}/touches`).body as { at: number }[];
    expect(body).toHaveLength(2);
    expect(body[0]!.at).toBeLessThan(body[1]!.at);
  });

  it('answers an empty list for a carrier with none', () => {
    expect(get(`/carriers/${carrierId(8)}/touches`).body).toEqual([]);
  });
});

describe('parameter readers', () => {
  it('read the two identifiers off the path', () => {
    expect(unwrap(inviteeOf({ invitee: carrierId(9) }))).toBe(carrierId(9));
    expect(unwrap(programOf({ program: programId(1) }))).toBe(programId(1));
    expect(isErr(inviteeOf({}))).toBe(true);
  });
});
