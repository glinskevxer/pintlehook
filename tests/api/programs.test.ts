import { beforeEach, describe, expect, it } from 'vitest';
import { programRoutes } from '../../src/api/programs.js';
import { Router, request } from '../../src/api/router.js';
import { programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 7, 15);

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

const bronze: RewardSchedule = {
  currency: 'USD',
  tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 }],
};

const withSilver: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 30_000, marginShare: 0 },
    { name: 'silver', fromCount: 3, flatMinor: 45_000, marginShare: 100 },
  ],
};

const program: Program = {
  id: programId(1),
  name: 'owner operator referral',
  openedOn: day(2024, 1, 1),
  versions: [
    { version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'opening' },
    {
      version: 2,
      effectiveFrom: day(2025, 7, 1),
      rules: { ...rules, cureWindowDays: 30 },
      note: 'longer cure',
    },
  ],
};

let store: Store;
let context: Context;
let catalog: Catalog;
let router: Router;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  catalog = unwrap(
    buildCatalog(
      [program],
      [
        { program: programId(1), version: 1, schedule: bronze },
        { program: programId(1), version: 2, schedule: withSilver },
      ],
    ),
  );
  router = new Router().addAll(programRoutes);
});

function get(path: string, query: Record<string, string> = {}) {
  return router.handle(context, catalog, request({ path, query }));
}

describe('listing programs', () => {
  it('answers every program with its version count', () => {
    const response = get('/programs');
    expect(response.status).toBe(200);
    const body = response.body as { program: string; versions: number }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.versions).toBe(2);
  });

  it('answers an empty list for an empty catalogue', () => {
    catalog = unwrap(buildCatalog([], []));
    expect(get('/programs').body).toEqual([]);
  });

  it('writes a null rather than nothing for an open program', () => {
    const body = get('/programs').body as { closedOn: string | null }[];
    expect(body[0]!.closedOn).toBeNull();
  });
});

describe('reading one program', () => {
  it('lists every version it has had', () => {
    const body = get(`/programs/${programId(1)}`).body as {
      versions: { version: number; effectiveFrom: string }[];
    };
    expect(body.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(body.versions[1]!.effectiveFrom).toBe('2025-07-01');
  });

  it('answers not found for a program nobody catalogued', () => {
    expect(get(`/programs/${programId(9)}`).status).toBe(404);
  });

  it('answers a bad request for something that is not a program id', () => {
    expect(get('/programs/nonsense').status).toBe(400);
  });
});

describe('reading the rules', () => {
  it('defaults to the day the context clock says', () => {
    const body = get(`/programs/${programId(1)}/rules`).body as {
      on: string;
      version: number;
      rules: ProgramRules;
    };
    expect(body.on).toBe('2025-08-15');
    expect(body.version).toBe(2);
    expect(body.rules.cureWindowDays).toBe(30);
  });

  it('answers for the day it was asked about rather than today', () => {
    const body = get(`/programs/${programId(1)}/rules`, { on: '2025-06-30' }).body as {
      version: number;
      rules: ProgramRules;
    };
    expect(body.version).toBe(1);
    expect(body.rules.cureWindowDays).toBe(21);
  });

  it('answers a bad request for a day it cannot read', () => {
    expect(get(`/programs/${programId(1)}/rules`, { on: 'soon' }).status).toBe(400);
  });

  it('fails for a day before the program had any version', () => {
    const response = get(`/programs/${programId(1)}/rules`, { on: '2023-01-01' });
    expect(response.status).toBe(404);
  });
});

describe('reading the schedule', () => {
  it('gives the ladder in force on the day', () => {
    const body = get(`/programs/${programId(1)}/schedule`, { on: '2025-06-30' }).body as {
      tiers: { name: string }[];
    };
    expect(body.tiers.map((tier) => tier.name)).toEqual(['bronze']);
  });

  it('gives the newer ladder after the version changed', () => {
    const body = get(`/programs/${programId(1)}/schedule`, { on: '2025-07-01' }).body as {
      tiers: { name: string }[];
      currency: string;
    };
    expect(body.tiers).toHaveLength(2);
    expect(body.currency).toBe('USD');
  });

  it('orders the tiers by threshold', () => {
    const body = get(`/programs/${programId(1)}/schedule`).body as {
      tiers: { fromCount: number }[];
    };
    expect(body.tiers.map((tier) => tier.fromCount)).toEqual([1, 3]);
  });

  it('answers not found for a program nobody catalogued', () => {
    expect(get(`/programs/${programId(9)}/schedule`).status).toBe(404);
  });
});

describe('the route table', () => {
  it('is read only', () => {
    expect(programRoutes.every((route) => route.method === 'get')).toBe(true);
  });

  it('routes four paths', () => {
    expect(programRoutes).toHaveLength(4);
  });
});
