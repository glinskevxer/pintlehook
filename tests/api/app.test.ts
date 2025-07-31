import { beforeEach, describe, expect, it } from 'vitest';
import { allRoutes, buildRouter, getHealth, routeCount, systemRoutes } from '../../src/api/app.js';
import { request, type Router } from '../../src/api/router.js';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

let store: Store;
let context: Context;
let catalog: Catalog;
let router: Router;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'operator'));
  catalog = unwrap(buildCatalog([], []));
  router = buildRouter();
});

function get(path: string, query: Record<string, string> = {}) {
  return router.handle(context, catalog, request({ path, query }));
}

describe('the assembled router', () => {
  it('routes every module', () => {
    expect(routeCount()).toBe(allRoutes.length);
    expect(routeCount()).toBeGreaterThan(14);
  });

  it('has no two routes on the same method and path', () => {
    expect(() => buildRouter()).not.toThrow();
  });

  it('gives every route a summary', () => {
    for (const route of allRoutes) {
      expect(route.summary.length).toBeGreaterThan(10);
    }
  });

  it('names two system routes', () => {
    expect(systemRoutes.map((route) => route.path)).toEqual(['/routes', '/health']);
  });
});

describe('the routes endpoint', () => {
  it('lists what is actually routed', () => {
    const body = get('/routes').body as { path: string }[];
    expect(body).toHaveLength(allRoutes.length);
    expect(body.map((row) => row.path)).toContain('/health');
  });

  it('lists them in a stable order', () => {
    const first = (get('/routes').body as { path: string }[]).map((row) => row.path);
    const second = (get('/routes').body as { path: string }[]).map((row) => row.path);
    expect(second).toEqual(first);
  });
});

describe('the health endpoint', () => {
  it('is healthy over an empty store', () => {
    const body = get('/health').body as { healthy: boolean; records: number };
    expect(body.healthy).toBe(true);
    expect(body.records).toBe(0);
  });

  it('counts the records in the journal', () => {
    unwrap(
      store.commit([
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
      ]),
    );
    expect((get('/health').body as { records: number }).records).toBe(1);
  });

  it('asks the integrity checks rather than answering a constant', () => {
    const orphan: JournalDraft = {
      at: AT,
      kind: 'advocate_enrolled',
      key: advocateId(1),
      payload: {
        advocate: advocateId(1),
        carrier: carrierId(9),
        program: programId(1),
        referralCode: 'AB3K9ZQ',
        from: '2025-01-01',
      },
    };
    unwrap(store.commit([orphan]));
    const body = get('/health').body as { healthy: boolean; integrityFindings: number };
    expect(body.healthy).toBe(false);
    expect(body.integrityFindings).toBeGreaterThan(0);
  });

  it('says how many checks it ran', () => {
    expect((get('/health').body as { integrityChecks: number }).integrityChecks).toBeGreaterThan(8);
  });

  it('reports the journal check separately', () => {
    const body = get('/health').body as { journalVerifies: boolean };
    expect(body.journalVerifies).toBe(true);
  });

  it('is the same handler that the router serves', () => {
    const direct = getHealth.handle(context, catalog, request({ path: '/health' }), {});
    expect(direct.ok).toBe(true);
  });
});

describe('unknown paths', () => {
  it('answer not found', () => {
    expect(get('/nothing').status).toBe(404);
  });
});
