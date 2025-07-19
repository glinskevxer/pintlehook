import { beforeEach, describe, expect, it } from 'vitest';
import { Router, request } from '../../src/api/router.js';
import { programQuery, settlementRoutes } from '../../src/api/settlements.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 2);

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 2,
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

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

const setup: JournalDraft[] = [
  {
    at: AT,
    kind: 'carrier_filed',
    key: carrierId(1),
    payload: {
      carrier: carrierId(1),
      legalName: 'Brannan Hauling',
      motorCarrierNumber: 'MC884210',
      dotNumber: '3126540',
      authorityStatus: 'active',
      remitDigest: 'r',
      bankDigest: 'b',
      powerUnits: 1,
    },
  },
  {
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
  },
  {
    at: AT,
    kind: 'accrual_posted',
    key: 'acr_1',
    payload: {
      accrual: 'acr_1',
      advocate: advocateId(1),
      program: programId(1),
      referralKey: 'prg_00000001:cxr_00000009',
      kind: 'base',
      postedOn: '2025-05-10',
      programYearFrom: '2025-01-01',
      amountMinor: 25_000,
      currency: 'USD',
      reverses: '',
      note: 'bounty',
    },
  },
];

let store: Store;
let context: Context;
let catalog: Catalog;
let router: Router;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement'));
  catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
  router = new Router().addAll(settlementRoutes);
  unwrap(store.commit(setup));
});

function post(path: string, body: Record<string, unknown>) {
  return router.handle(context, catalog, request({ method: 'post', path, body }));
}

function get(path: string, query: Record<string, string> = {}) {
  return router.handle(context, catalog, request({ path, query }));
}

const cutBody = {
  program: programId(1),
  periodFrom: '2025-05-01',
  periodUntil: '2025-06-01',
  cutOn: '2025-06-02',
  currency: 'USD',
};

describe('cutting a batch', () => {
  it('cuts and writes it', () => {
    const response = post('/settlements', cutBody);
    expect(response.status).toBe(201);
    const body = response.body as { batch: string; lines: number; payableMinor: number };
    expect(body.lines).toBe(1);
    expect(body.payableMinor).toBe(25_000);
    expect(store.batches.get(body.batch)!.state).toBe('cut');
  });

  it('previews without writing when asked for a dry run', () => {
    const response = post('/settlements', { ...cutBody, dryRun: true });
    const body = response.body as { batch: string; dryRun: boolean; payableMinor: number };
    expect(body.dryRun).toBe(true);
    expect(body.payableMinor).toBe(25_000);
    expect(store.batches.size).toBe(0);
  });

  it('reports whether the columns add up', () => {
    expect((post('/settlements', cutBody).body as { adds: boolean }).adds).toBe(true);
  });

  it('refuses a cut before the period closes', () => {
    const response = post('/settlements', { ...cutBody, cutOn: '2025-05-20' });
    expect(response.status).toBe(422);
    expect((response.body as { error: string }).error).toBe('settlement_cut_too_early');
  });

  it('refuses a currency we do not carry', () => {
    const response = post('/settlements', { ...cutBody, currency: 'GBP' });
    expect(response.status).toBe(400);
    expect((response.body as { path: string }).path).toBe('currency');
  });

  it('refuses a missing period', () => {
    const { periodFrom: _from, ...rest } = cutBody;
    expect(post('/settlements', rest).status).toBe(400);
  });

  it('refuses a program the catalogue does not hold', () => {
    expect(post('/settlements', { ...cutBody, program: programId(9) }).status).toBe(404);
  });
});

describe('reading a batch', () => {
  it('answers where it has got to', () => {
    const cut = post('/settlements', cutBody).body as { batch: string };
    const body = get(`/settlements/${cut.batch}`).body as { state: string; periodFrom: string };
    expect(body.state).toBe('cut');
    expect(body.periodFrom).toBe('2025-05-01');
  });

  it('answers not found for a batch nobody cut', () => {
    expect(get('/settlements/bch_00000099').status).toBe(404);
  });

  it('answers a bad request for something that is not a batch id', () => {
    expect(get('/settlements/nonsense').status).toBe(400);
  });
});

describe('moving a batch along', () => {
  it('releases then pays', () => {
    const cut = post('/settlements', cutBody).body as { batch: string };
    expect(post(`/settlements/${cut.batch}/release`, { releasedOn: '2025-06-03' }).status).toBe(
      201,
    );
    expect(store.batches.get(cut.batch)!.state).toBe('released');
    expect(post(`/settlements/${cut.batch}/pay`, { paidOn: '2025-06-05' }).status).toBe(201);
    expect(store.batches.get(cut.batch)!.state).toBe('paid');
  });

  it('refuses to pay before releasing', () => {
    const cut = post('/settlements', cutBody).body as { batch: string };
    const response = post(`/settlements/${cut.batch}/pay`, { paidOn: '2025-06-05' });
    expect(response.status).toBe(409);
  });

  it('refuses a release with no day on it', () => {
    const cut = post('/settlements', cutBody).body as { batch: string };
    expect(post(`/settlements/${cut.batch}/release`, {}).status).toBe(400);
  });

  it('refuses a release dated before the cut', () => {
    const cut = post('/settlements', cutBody).body as { batch: string };
    expect(post(`/settlements/${cut.batch}/release`, { releasedOn: '2025-06-01' }).status).toBe(
      422,
    );
  });
});

describe('listing batches', () => {
  it('lists everything with no filter', () => {
    post('/settlements', cutBody);
    expect(get('/settlements').body).toHaveLength(1);
  });

  it('filters by state', () => {
    post('/settlements', cutBody);
    expect(get('/settlements', { state: 'cut' }).body).toHaveLength(1);
    expect(get('/settlements', { state: 'paid' }).body).toEqual([]);
  });

  it('answers an empty list before anything is cut', () => {
    expect(get('/settlements').body).toEqual([]);
  });
});

describe('programQuery', () => {
  it('reads the program off the query', () => {
    expect(unwrap(programQuery(request({ query: { program: programId(1) } })))).toBe(programId(1));
    expect(isErr(programQuery(request()))).toBe(true);
  });
});
