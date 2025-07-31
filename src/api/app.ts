/**
 * Assembling the api. One place where every route is put together, plus the
 * two endpoints an operator needs before anything else: what is routed, and
 * whether the journal still verifies.
 *
 * The health endpoint reports the journal check rather than a constant. A
 * health endpoint that answers yes without asking anything is worse than not
 * having one, because it will keep answering yes while the store is unusable.
 */

import { ok } from '../util/result.js';
import { runIntegrity } from '../storage/integrity.js';
import { trailIsTrustworthy } from '../service/auditTrail.js';
import { programRoutes } from './programs.js';
import { referralRoutes } from './referrals.js';
import { reportRoutes } from './reports.js';
import { Router, type Route } from './router.js';
import { settlementRoutes } from './settlements.js';

export const getRoutes: Route = {
  method: 'get',
  path: '/routes',
  summary: 'every route this api answers',
  handle: () =>
    ok(
      buildRouter()
        .list()
        .map((route) => ({
          method: route.method,
          path: route.path,
          summary: route.summary,
        })),
    ),
};

export const getHealth: Route = {
  method: 'get',
  path: '/health',
  summary: 'whether the journal still verifies and the tables still hold together',
  handle: (context) => {
    const trustworthy = trailIsTrustworthy(context);
    const integrity = runIntegrity(context.store);
    return ok({
      healthy: trustworthy && integrity.clean,
      journalVerifies: trustworthy,
      records: context.store.sequence,
      integrityChecks: integrity.checksRun,
      integrityFindings: integrity.findings.length,
    });
  },
};

export const systemRoutes: readonly Route[] = [getRoutes, getHealth];

export const allRoutes: readonly Route[] = [
  ...systemRoutes,
  ...programRoutes,
  ...referralRoutes,
  ...settlementRoutes,
  ...reportRoutes,
];

export function buildRouter(): Router {
  return new Router().addAll(allRoutes);
}

export function routeCount(): number {
  return allRoutes.length;
}
