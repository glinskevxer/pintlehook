/**
 * The report registry. Every report is reachable by name with the same
 * argument shape, so the command line and the api both dispatch through here
 * rather than each carrying their own list.
 *
 * The list being in one place is what makes it possible to say honestly which
 * reports exist. Two lists means one of them is out of date and nobody knows
 * which.
 */

import type { Day } from '../util/clock.js';
import type { Currency } from '../util/money.js';
import { byText, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, ProgramId } from '../domain/identity.js';
import type { Catalog } from '../service/catalog.js';
import type { Context } from '../service/context.js';
import { buildExceptions } from '../service/exceptionService.js';
import { agingFor, agingReport } from './aging.js';
import { exceptionReport } from './exceptions.js';
import { advocateLanes, laneReport, lanesForInvitees } from './lanes.js';
import { performanceFor, performanceReport } from './performance.js';
import { cohortsFor, retentionReport } from './retention.js';
import { buildStatement, statementReport } from './statement.js';
import { render, validateReport, type Shape } from './table.js';

export interface ReportRequest {
  readonly program: ProgramId;
  readonly currency: Currency;
  readonly asOf: Day;
  readonly advocate?: AdvocateId | undefined;
}

export interface ReportDefinition {
  readonly name: string;
  readonly summary: string;
  readonly needsAdvocate: boolean;
  readonly run: (
    context: Context,
    catalog: Catalog,
    request: ReportRequest,
    shape: Shape,
  ) => Result<string>;
}

function requireAdvocate(request: ReportRequest): Result<AdvocateId> {
  return request.advocate === undefined
    ? fail('report_advocate_required', 'this report needs an advocate')
    : ok(request.advocate);
}

const DEFINITIONS: readonly ReportDefinition[] = [
  {
    name: 'statement',
    summary: 'one advocate, every posting, with a running balance',
    needsAdvocate: true,
    run: (context, _catalog, request, shape) => {
      const advocate = requireAdvocate(request);
      if (!advocate.ok) {
        return advocate;
      }
      const statement = buildStatement(context, advocate.value, request.currency);
      if (!statement.ok) {
        return statement;
      }
      return renderChecked(statementReport(statement.value), shape);
    },
  },
  {
    name: 'performance',
    summary: 'bounty cost against delivered margin, per advocate',
    needsAdvocate: false,
    run: (context, _catalog, request, shape) => {
      const rows = performanceFor(context, request.program, request.currency);
      if (!rows.ok) {
        return rows;
      }
      return renderChecked(performanceReport(rows.value, request.currency), shape);
    },
  },
  {
    name: 'exceptions',
    summary: 'everything the referral desk has to work, oldest first',
    needsAdvocate: false,
    run: (context, catalog, request, shape) => {
      const exceptions = buildExceptions(context, catalog, request.program);
      if (!exceptions.ok) {
        return exceptions;
      }
      return renderChecked(exceptionReport(exceptions.value, request.asOf), shape);
    },
  },
  {
    name: 'retention',
    summary: 'invited carriers by activation month and how long they kept hauling',
    needsAdvocate: false,
    run: (context, _catalog, request, shape) => {
      const rows = cohortsFor(context, request.program);
      if (!rows.ok) {
        return rows;
      }
      return renderChecked(retentionReport(rows.value, request.asOf), shape);
    },
  },
  {
    name: 'aging',
    summary: 'what the program owes, by how long it has been sitting',
    needsAdvocate: false,
    run: (context, _catalog, request, shape) => {
      const rows = agingFor(context, request.program, request.asOf, request.currency);
      if (!rows.ok) {
        return rows;
      }
      return renderChecked(agingReport(rows.value, request.asOf, request.currency), shape);
    },
  },
  {
    name: 'lanes',
    summary: 'the lanes an advocate brought in against the lanes they run',
    needsAdvocate: true,
    run: (context, _catalog, request, shape) => {
      const advocate = requireAdvocate(request);
      if (!advocate.ok) {
        return advocate;
      }
      const mine = advocateLanes(context, advocate.value, request.currency);
      if (!mine.ok) {
        return mine;
      }
      const theirs = lanesForInvitees(context, advocate.value, request.program, request.currency);
      if (!theirs.ok) {
        return theirs;
      }
      return renderChecked(
        laneReport(theirs.value, `lanes brought in by ${advocate.value}`, request.currency),
        shape,
      );
    },
  },
];

function renderChecked<T>(report: Parameters<typeof validateReport<T>>[0], shape: Shape) {
  const checked = validateReport(report);
  return checked.ok ? ok(render(checked.value, shape)) : checked;
}

export function reportNames(): string[] {
  return sorted(
    DEFINITIONS.map((definition) => definition.name),
    byText,
  );
}

export function definitionOf(name: string): Result<ReportDefinition> {
  const found = DEFINITIONS.find((definition) => definition.name === name);
  return found === undefined
    ? fail('report_unknown', `no report called "${name}", try ${reportNames().join(', ')}`)
    : ok(found);
}

export function runReport(
  context: Context,
  catalog: Catalog,
  name: string,
  request: ReportRequest,
  shape: Shape,
): Result<string> {
  const definition = definitionOf(name);
  if (!definition.ok) {
    return definition;
  }
  if (definition.value.needsAdvocate && request.advocate === undefined) {
    return fail('report_advocate_required', `the ${name} report needs an advocate`);
  }
  return definition.value.run(context, catalog, request, shape);
}

export function definitions(): readonly ReportDefinition[] {
  return DEFINITIONS;
}
