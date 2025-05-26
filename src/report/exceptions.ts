/**
 * The exception report. The referral desk works from this and from nothing
 * else, so it is ordered by what has to be done rather than by when it
 * happened, and the oldest item inside each severity comes first.
 *
 * The age column is the point of the report. An action item that has been open
 * for ninety days is a different problem from one raised this morning, and a
 * report that only lists them tells you nothing about which.
 */

import { formatDay, type Day } from '../util/clock.js';
import { ascending, byKey, byText, chain, groupBy, sorted } from '../util/ordering.js';
import {
  ageInDays,
  countByKind,
  exceptionOrder,
  needsAction,
  severityOf,
  type ExceptionKind,
  type ExceptionSeverity,
  type ProgramException,
} from '../domain/exception.js';
import { numberColumn, textColumn, type Report } from './table.js';

export interface ExceptionRow {
  readonly kind: ExceptionKind;
  readonly severity: ExceptionSeverity;
  readonly subject: string;
  readonly raisedOn: Day;
  readonly ageDays: number;
  readonly detail: string;
}

export function rowsOf(exceptions: readonly ProgramException[], asOf: Day): ExceptionRow[] {
  return sorted(exceptions, exceptionOrder).map((exception) => ({
    kind: exception.kind,
    severity: severityOf(exception.kind),
    subject: exception.subject,
    raisedOn: exception.raisedOn,
    ageDays: ageInDays(exception, asOf),
    detail: exception.detail,
  }));
}

export function exceptionReport(
  exceptions: readonly ProgramException[],
  asOf: Day,
): Report<ExceptionRow> {
  const rows = rowsOf(exceptions, asOf);
  const actions = rows.filter((row) => row.severity === 'action').length;
  const oldest = rows.reduce((worst, row) => Math.max(worst, row.ageDays), 0);
  return {
    title: `exception report as at ${formatDay(asOf)}`,
    columns: [
      textColumn<ExceptionRow>('severity', 'do', (row) => row.severity),
      textColumn<ExceptionRow>('kind', 'kind', (row) => row.kind),
      textColumn<ExceptionRow>('subject', 'subject', (row) => row.subject),
      textColumn<ExceptionRow>('raised', 'raised', (row) => formatDay(row.raisedOn)),
      numberColumn<ExceptionRow>('age', 'days', (row) => row.ageDays),
      textColumn<ExceptionRow>('detail', 'detail', (row) => row.detail),
    ],
    rows,
    footnotes: [
      `${actions} of ${rows.length} need action`,
      `the oldest open item is ${oldest} days old`,
    ],
  };
}

export function oldestFirst(rows: readonly ExceptionRow[]): ExceptionRow[] {
  return sorted(
    rows,
    chain(
      byKey((row: ExceptionRow) => -row.ageDays, ascending),
      byKey((row: ExceptionRow) => row.subject, byText),
    ),
  );
}

export function byKindReport(exceptions: readonly ProgramException[]): Report<[string, number]> {
  const counts = [...countByKind(exceptions).entries()];
  return {
    title: 'exceptions by kind',
    columns: [
      textColumn<[string, number]>('kind', 'kind', (row) => row[0]),
      numberColumn<[string, number]>('count', 'count', (row) => row[1]),
    ],
    rows: sorted(counts, (left, right) => byText(left[0], right[0])),
    footnotes: [`${exceptions.length} exceptions in total`],
  };
}

export function subjectsNeedingAction(exceptions: readonly ProgramException[]): string[] {
  return [...new Set(exceptions.filter(needsAction).map((exception) => exception.subject))].sort();
}

export function bySeverity(rows: readonly ExceptionRow[]): Map<ExceptionSeverity, ExceptionRow[]> {
  return groupBy(rows, (row) => row.severity);
}

export function staleActions(rows: readonly ExceptionRow[], olderThanDays: number): ExceptionRow[] {
  return oldestFirst(
    rows.filter((row) => row.severity === 'action' && row.ageDays >= olderThanDays),
  );
}
