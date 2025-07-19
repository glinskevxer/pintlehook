/**
 * Settlement routes. Cutting a batch, reading one back, and moving it along.
 *
 * Cutting is a post because it writes, but it is also the one route where the
 * caller can ask for a dry run. The settlement desk wants to see the register
 * before it exists, and giving them a preview that runs the real code is much
 * safer than giving them a separate estimate that can disagree with it.
 */

import { formatDay, parseDay } from '../util/clock.js';
import { isCurrency } from '../util/money.js';
import { interval } from '../util/interval.js';
import { fail, ok, type Result } from '../util/result.js';
import { readBatchId, readProgramId } from '../domain/identity.js';
import { summarize } from '../report/register.js';
import { batchById, payBatch, releaseBatch } from '../service/releaseService.js';
import { cutBatch } from '../service/settlementService.js';
import { optionalQuery, requiredQuery, type ApiRequest, type Route } from './router.js';

function dayField(body: Readonly<Record<string, unknown>>, field: string) {
  const value = body[field];
  return typeof value === 'string'
    ? parseDay(value)
    : fail('body_field_missing', `${field} is required`, field);
}

function textField(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function requestFrom(request: ApiRequest) {
  const program = readProgramId(textField(request.body, 'program'));
  if (!program.ok) {
    return program;
  }
  const from = dayField(request.body, 'periodFrom');
  if (!from.ok) {
    return from;
  }
  const until = dayField(request.body, 'periodUntil');
  if (!until.ok) {
    return until;
  }
  const cutOn = dayField(request.body, 'cutOn');
  if (!cutOn.ok) {
    return cutOn;
  }
  const currency = textField(request.body, 'currency') || 'USD';
  if (!isCurrency(currency)) {
    return fail('body_currency_unsupported', `we do not carry ${currency}`, 'currency');
  }
  return ok({
    program: program.value,
    period: interval(from.value, until.value),
    cutOn: cutOn.value,
    currency,
  });
}

export const postBatch: Route = {
  method: 'post',
  path: '/settlements',
  summary: 'cut a settlement batch, or preview one with dryRun',
  handle: (context, catalog, request) => {
    const parsed = requestFrom(request);
    if (!parsed.ok) {
      return parsed;
    }
    const plan = cutBatch(context, catalog, parsed.value);
    if (!plan.ok) {
      return plan;
    }
    const dryRun = request.body['dryRun'] === true;
    if (!dryRun) {
      const written = context.store.commit([...plan.value.drafts]);
      if (!written.ok) {
        return written;
      }
    }
    const summary = summarize(plan.value.batch);
    return ok({
      batch: plan.value.batch.id,
      dryRun,
      lines: summary.lines,
      held: summary.held,
      payableMinor: summary.payable.minor,
      withheldMinor: summary.withheld.minor,
      adds: summary.adds,
    });
  },
};

export const getBatch: Route = {
  method: 'get',
  path: '/settlements/:batch',
  summary: 'one batch and where it has got to',
  handle: (context, _catalog, _request, params) => {
    const batch = readBatchId(params['batch'] ?? '');
    if (!batch.ok) {
      return batch;
    }
    const row = batchById(context, batch.value);
    if (!row.ok) {
      return row;
    }
    return ok({
      batch: row.value.id,
      state: row.value.state,
      periodFrom: row.value.periodFrom,
      periodUntil: row.value.periodUntil,
      cutOn: row.value.cutOn,
      currency: row.value.currency,
    });
  },
};

function moveRoute(path: string, summary: string, move: typeof releaseBatch, field: string): Route {
  return {
    method: 'post',
    path,
    summary,
    handle: (context, _catalog, request, params) => {
      const batch = readBatchId(params['batch'] ?? '');
      if (!batch.ok) {
        return batch;
      }
      const on = dayField(request.body, field);
      if (!on.ok) {
        return on;
      }
      const drafts = move(context, batch.value, on.value);
      if (!drafts.ok) {
        return drafts;
      }
      const written = context.store.commit(drafts.value);
      if (!written.ok) {
        return written;
      }
      return ok({ batch: batch.value, [field]: formatDay(on.value) });
    },
  };
}

export const postRelease = moveRoute(
  '/settlements/:batch/release',
  'release a cut batch to accounts payable',
  releaseBatch,
  'releasedOn',
);

export const postPay = moveRoute(
  '/settlements/:batch/pay',
  'mark a released batch paid',
  payBatch,
  'paidOn',
);

export const listBatches: Route = {
  method: 'get',
  path: '/settlements',
  summary: 'batches, filtered by state when the query says so',
  handle: (context, _catalog, request) => {
    const state = optionalQuery(request, 'state');
    const rows = context.store.batches
      .where((row) => state === undefined || row.state === state)
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    return ok(rows.map((row) => ({ batch: row.id, state: row.state, cutOn: row.cutOn })));
  },
};

export const settlementRoutes: readonly Route[] = [
  postBatch,
  listBatches,
  getBatch,
  postRelease,
  postPay,
];

export function programQuery(request: ApiRequest): Result<string> {
  return requiredQuery(request, 'program');
}
