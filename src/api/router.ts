/**
 * An in process router. Requests are plain values and so are responses, and
 * nothing here knows about sockets.
 *
 * That is not an abstraction for its own sake. The settlement run and the
 * command line both go through the same handlers as anything that ever fronts
 * this over http, so a rule cannot be enforced on one path and skipped on
 * another, and the whole surface is testable without standing anything up.
 */

import { byText, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Catalog } from '../service/catalog.js';
import type { Context } from '../service/context.js';
import { errorFrom, type ApiError } from './errors.js';

export type Method = 'get' | 'post';

export interface ApiRequest {
  readonly method: Method;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly actor: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface Route {
  readonly method: Method;
  /** A path with optional segments named like :advocate. */
  readonly path: string;
  readonly summary: string;
  readonly handle: (
    context: Context,
    catalog: Catalog,
    request: ApiRequest,
    params: Readonly<Record<string, string>>,
  ) => Result<unknown>;
}

export function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

export function matchPath(
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | undefined {
  const wanted = segmentsOf(pattern);
  const given = segmentsOf(path);
  if (wanted.length !== given.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let at = 0; at < wanted.length; at += 1) {
    const slot = wanted[at] as string;
    const value = given[at] as string;
    if (slot.startsWith(':')) {
      params[slot.slice(1)] = value;
      continue;
    }
    if (slot !== value) {
      return undefined;
    }
  }
  return params;
}

export class Router {
  private readonly routes: Route[] = [];

  add(route: Route): Router {
    const clash = this.routes.find(
      (held) => held.method === route.method && held.path === route.path,
    );
    if (clash !== undefined) {
      throw new Error(`${route.method} ${route.path} is already routed`);
    }
    this.routes.push(route);
    return this;
  }

  addAll(routes: readonly Route[]): Router {
    for (const route of routes) {
      this.add(route);
    }
    return this;
  }

  list(): Route[] {
    return sorted(this.routes, (left, right) => {
      const byPath = byText(left.path, right.path);
      return byPath !== 0 ? byPath : byText(left.method, right.method);
    });
  }

  find(
    method: Method,
    path: string,
  ): Result<{ route: Route; params: Readonly<Record<string, string>> }> {
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchPath(route.path, path);
      if (params === undefined) {
        continue;
      }
      pathMatched = true;
      if (route.method === method) {
        return ok({ route, params });
      }
    }
    return pathMatched
      ? fail('route_method_not_allowed', `${path} does not answer ${method}`)
      : fail('route_unknown', `nothing is routed at ${path}`);
  }

  handle(context: Context, catalog: Catalog, request: ApiRequest): ApiResponse {
    const found = this.find(request.method, request.path);
    if (!found.ok) {
      return responseFor(errorFrom(found.problems));
    }
    const result = found.value.route.handle(context, catalog, request, found.value.params);
    if (!result.ok) {
      return responseFor(errorFrom(result.problems));
    }
    return { status: request.method === 'post' ? 201 : 200, body: result.value };
  }
}

export function responseFor(error: ApiError): ApiResponse {
  return {
    status: error.status,
    body: {
      error: error.code,
      message: error.message,
      path: error.path,
      problems: error.problems,
    },
  };
}

export function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'get',
    path: '/',
    query: {},
    body: {},
    actor: 'anonymous',
    ...overrides,
  };
}

export function requiredQuery(request: ApiRequest, name: string): Result<string> {
  const value = request.query[name];
  return value === undefined || value.trim() === ''
    ? fail('query_missing', `the ${name} query parameter is required`, name)
    : ok(value.trim());
}

export function optionalQuery(request: ApiRequest, name: string): string | undefined {
  const value = request.query[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}
