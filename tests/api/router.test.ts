import { beforeEach, describe, expect, it } from 'vitest';
import { programId } from '../../src/domain/identity.js';
import {
  Router,
  matchPath,
  optionalQuery,
  request,
  requiredQuery,
  responseFor,
  segmentsOf,
  type Route,
} from '../../src/api/router.js';
import { errorFrom } from '../../src/api/errors.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { Store } from '../../src/storage/store.js';
import { fail, isErr, ok, problem, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 8, 1);

const echo: Route = {
  method: 'get',
  path: '/advocates/:advocate/statement',
  summary: 'echo the advocate back',
  handle: (_context, _catalog, _request, params) => ok({ advocate: params['advocate'] }),
};

const create: Route = {
  method: 'post',
  path: '/advocates',
  summary: 'create an advocate',
  handle: () => ok({ created: true }),
};

const broken: Route = {
  method: 'get',
  path: '/broken',
  summary: 'always fails',
  handle: () => fail('carrier_unknown', 'no carrier cxr_9'),
};

let store: Store;
let context: Context;
let catalog: Catalog;
let router: Router;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  catalog = unwrap(buildCatalog([], []));
  router = new Router().addAll([echo, create, broken]);
});

describe('segmentsOf and matchPath', () => {
  it('drops empty segments', () => {
    expect(segmentsOf('/a//b/')).toEqual(['a', 'b']);
  });

  it('matches a literal path', () => {
    expect(matchPath('/advocates', '/advocates')).toEqual({});
  });

  it('pulls out a named segment', () => {
    expect(matchPath('/advocates/:advocate', '/advocates/adv_1')).toEqual({ advocate: 'adv_1' });
  });

  it('refuses a different length', () => {
    expect(matchPath('/advocates/:advocate', '/advocates')).toBeUndefined();
  });

  it('refuses a literal that does not match', () => {
    expect(matchPath('/advocates/:advocate', '/carriers/cxr_1')).toBeUndefined();
  });

  it('matches several named segments', () => {
    expect(matchPath('/a/:one/b/:two', '/a/1/b/2')).toEqual({ one: '1', two: '2' });
  });
});

describe('the route table', () => {
  it('refuses the same method and path twice', () => {
    expect(() => router.add(echo)).toThrow(/already routed/);
  });

  it('allows two methods on one path', () => {
    expect(() => router.add({ ...create, method: 'get', summary: 'list advocates' })).not.toThrow();
  });

  it('lists routes in a stable order', () => {
    const paths = router.list().map((route) => route.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it('gives every route a summary', () => {
    for (const route of router.list()) {
      expect(route.summary.length).toBeGreaterThan(3);
    }
  });
});

describe('find', () => {
  it('finds a route and its parameters', () => {
    const found = unwrap(router.find('get', '/advocates/adv_1/statement'));
    expect(found.params['advocate']).toBe('adv_1');
  });

  it('says the path is unrouted when nothing matches', () => {
    const r = router.find('get', '/nothing');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('route_unknown');
    }
  });

  it('says the method is wrong when the path matched', () => {
    const r = router.find('post', '/broken');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('route_method_not_allowed');
    }
  });
});

describe('handle', () => {
  it('answers two hundred on a get', () => {
    const response = router.handle(
      context,
      catalog,
      request({ path: '/advocates/adv_1/statement' }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ advocate: 'adv_1' });
  });

  it('answers two hundred and one on a post', () => {
    const response = router.handle(
      context,
      catalog,
      request({ method: 'post', path: '/advocates' }),
    );
    expect(response.status).toBe(201);
  });

  it('turns a handler failure into the mapped status', () => {
    const response = router.handle(context, catalog, request({ path: '/broken' }));
    expect(response.status).toBe(404);
    expect((response.body as { error: string }).error).toBe('carrier_unknown');
  });

  it('answers an unrouted path as not found', () => {
    const response = router.handle(context, catalog, request({ path: '/nothing' }));
    expect(response.status).toBe(404);
    expect((response.body as { error: string }).error).toBe('route_unknown');
  });

  it('answers a routed path asked with the wrong method as a bad request', () => {
    const response = router.handle(context, catalog, request({ method: 'post', path: '/broken' }));
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe('route_method_not_allowed');
  });
});

describe('responseFor', () => {
  it('puts every problem in the body', () => {
    const response = responseFor(errorFrom([problem('a', 'first'), problem('b', 'second')]));
    expect((response.body as { problems: unknown[] }).problems).toHaveLength(2);
  });
});

describe('query helpers', () => {
  it('reads a required parameter', () => {
    expect(unwrap(requiredQuery(request({ query: { program: programId(1) } }), 'program'))).toBe(
      programId(1),
    );
  });

  it('trims a required parameter', () => {
    expect(unwrap(requiredQuery(request({ query: { a: ' x ' } }), 'a'))).toBe('x');
  });

  it('fails on a missing or blank required parameter', () => {
    expect(isErr(requiredQuery(request(), 'program'))).toBe(true);
    expect(isErr(requiredQuery(request({ query: { program: '  ' } }), 'program'))).toBe(true);
  });

  it('reads an optional parameter as nothing when blank', () => {
    expect(optionalQuery(request({ query: { a: '  ' } }), 'a')).toBeUndefined();
    expect(optionalQuery(request({ query: { a: 'x' } }), 'a')).toBe('x');
  });
});
