import { beforeEach, describe, expect, it } from 'vitest';
import { reportRoutes } from '../../src/api/reports.js';
import { Router, request } from '../../src/api/router.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { reportNames } from '../../src/report/registry.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

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
];

let store: Store;
let context: Context;
let catalog: Catalog;
let router: Router;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
  router = new Router().addAll(reportRoutes);
  unwrap(store.commit(setup));
});

function get(path: string, query: Record<string, string> = {}) {
  return router.handle(context, catalog, request({ path, query }));
}

describe('listing reports', () => {
  it('lists exactly what the registry holds', () => {
    const body = get('/reports').body as { name: string }[];
    expect(body.map((row) => row.name).sort()).toEqual(reportNames());
  });

  it('says which ones need an advocate', () => {
    const body = get('/reports').body as { name: string; needsAdvocate: boolean }[];
    expect(body.find((row) => row.name === 'statement')!.needsAdvocate).toBe(true);
    expect(body.find((row) => row.name === 'aging')!.needsAdvocate).toBe(false);
  });
});

describe('running a report', () => {
  it('runs one and answers with it rendered', () => {
    const response = get('/reports/aging', { program: programId(1) });
    expect(response.status).toBe(200);
    const body = response.body as { report: string; shape: string; body: string };
    expect(body.report).toBe('aging');
    expect(body.shape).toBe('text');
    expect(body.body).toContain('accrual ageing');
  });

  it('answers in the shape that was asked for', () => {
    const body = get('/reports/aging', { program: programId(1), shape: 'json' }).body as {
      body: string;
    };
    expect(body.body).toContain('"rows"');
  });

  it('answers csv when asked for csv rather than converting later', () => {
    const body = get('/reports/performance', { program: programId(1), shape: 'csv' }).body as {
      body: string;
    };
    expect(body.body.split('\n')[0]).toContain('advocate,opened');
  });

  it('defaults the as of day to the context clock', () => {
    const body = get('/reports/aging', { program: programId(1) }).body as { asOf: string };
    expect(body.asOf).toBe('2025-09-01');
  });

  it('takes an as of day when given one', () => {
    const body = get('/reports/aging', { program: programId(1), asOf: '2025-06-01' }).body as {
      asOf: string;
    };
    expect(body.asOf).toBe('2025-06-01');
  });

  it('runs every registered report over this store', () => {
    for (const name of reportNames()) {
      const response = get(`/reports/${name}`, {
        program: programId(1),
        advocate: advocateId(1),
      });
      expect(response.status).toBe(200);
    }
  });

  it('needs a program', () => {
    const response = get('/reports/aging');
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe('query_missing');
  });

  it('refuses a report that needs an advocate when none was given', () => {
    const response = get('/reports/statement', { program: programId(1) });
    expect(response.status).toBe(422);
  });

  it('refuses a shape it does not render', () => {
    const response = get('/reports/aging', { program: programId(1), shape: 'pdf' });
    expect(response.status).toBe(404);
    expect((response.body as { error: string }).error).toBe('report_shape_unknown');
  });

  it('refuses a currency we do not carry', () => {
    const response = get('/reports/aging', { program: programId(1), currency: 'GBP' });
    expect(response.status).toBe(400);
  });

  it('refuses a day it cannot read', () => {
    expect(get('/reports/aging', { program: programId(1), asOf: 'soon' }).status).toBe(400);
  });

  it('refuses an advocate identifier of the wrong kind', () => {
    const response = get('/reports/statement', {
      program: programId(1),
      advocate: carrierId(1),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a report nobody registered', () => {
    expect(get('/reports/profit', { program: programId(1) }).status).toBe(404);
  });

  it('passes a failure from inside the report through', () => {
    const response = get('/reports/statement', {
      program: programId(1),
      advocate: advocateId(9),
    });
    expect(response.status).toBe(404);
  });
});
