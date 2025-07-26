/**
 * Report routes. Every report goes through the registry, so this file never
 * has to learn about a new one, and the list endpoint cannot go out of date
 * with what is actually runnable.
 *
 * The body is the rendered report rather than a structure, because the shape a
 * caller asked for is the answer. Handing back json when they asked for csv and
 * letting them convert is how two renderings of the same report end up in
 * circulation.
 */

import { formatDay, parseDay } from '../util/clock.js';
import { isCurrency } from '../util/money.js';
import { fail, ok } from '../util/result.js';
import { readAdvocateId, readProgramId } from '../domain/identity.js';
import { definitions, runReport } from '../report/registry.js';
import { parseShape } from '../report/table.js';
import { optionalQuery, requiredQuery, type Route } from './router.js';

export const listReports: Route = {
  method: 'get',
  path: '/reports',
  summary: 'every report that can be run, with what it needs',
  handle: () =>
    ok(
      definitions().map((definition) => ({
        name: definition.name,
        summary: definition.summary,
        needsAdvocate: definition.needsAdvocate,
      })),
    ),
};

export const getReport: Route = {
  method: 'get',
  path: '/reports/:name',
  summary: 'run one report and answer with it rendered in the shape asked for',
  handle: (context, catalog, request, params) => {
    const name = params['name'];
    if (name === undefined) {
      return fail('query_missing', 'the report name is required', 'name');
    }
    const program = requiredQuery(request, 'program');
    if (!program.ok) {
      return program;
    }
    const programId = readProgramId(program.value);
    if (!programId.ok) {
      return programId;
    }
    const shape = parseShape(optionalQuery(request, 'shape') ?? 'text');
    if (!shape.ok) {
      return shape;
    }
    const currency = optionalQuery(request, 'currency') ?? 'USD';
    if (!isCurrency(currency)) {
      return fail('query_currency_unsupported', `we do not carry ${currency}`, 'currency');
    }
    const rawAsOf = optionalQuery(request, 'asOf');
    const asOf = rawAsOf === undefined ? ok(context.clock.today()) : parseDay(rawAsOf);
    if (!asOf.ok) {
      return asOf;
    }
    const rawAdvocate = optionalQuery(request, 'advocate');
    let advocate;
    if (rawAdvocate !== undefined) {
      const read = readAdvocateId(rawAdvocate);
      if (!read.ok) {
        return read;
      }
      advocate = read.value;
    }
    const rendered = runReport(
      context,
      catalog,
      name,
      { program: programId.value, currency, asOf: asOf.value, advocate },
      shape.value,
    );
    if (!rendered.ok) {
      return rendered;
    }
    return ok({
      report: name,
      shape: shape.value,
      asOf: formatDay(asOf.value),
      body: rendered.value,
    });
  },
};

export const reportRoutes: readonly Route[] = [listReports, getReport];
