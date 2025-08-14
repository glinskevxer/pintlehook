/**
 * Running a report from the command line. It goes through the same registry
 * the api uses, so a report cannot exist on one and not the other, and the
 * shape option is the same three words in both places.
 */

import { formatDay } from '../util/clock.js';
import { fail, ok } from '../util/result.js';
import { readAdvocateId } from '../domain/identity.js';
import { definitions, reportNames, runReport } from '../report/registry.js';
import { parseShape } from '../report/table.js';
import type { Catalog } from '../service/catalog.js';
import { asOfOf, currencyOf, programOf, type CommonOptions } from './commands.js';
import { EXIT_OK, emit, emitLines, reportProblems, type Sink } from './output.js';
import type { Session } from './session.js';

export interface ReportOptions extends CommonOptions {
  readonly shape?: string | undefined;
  readonly advocate?: string | undefined;
}

export function listReportsCommand(sink: Sink): number {
  return emitLines(
    sink,
    definitions().map(
      (definition) =>
        `${definition.name.padEnd(12)}${definition.summary}${definition.needsAdvocate ? '  (needs an advocate)' : ''}`,
    ),
  );
}

export function reportCommand(
  session: Session,
  catalog: Catalog,
  sink: Sink,
  name: string,
  options: ReportOptions,
): number {
  const program = programOf(options);
  if (!program.ok) {
    return reportProblems(sink, program.problems);
  }
  const currency = currencyOf(options);
  if (!currency.ok) {
    return reportProblems(sink, currency.problems);
  }
  const asOf = asOfOf(session, options);
  if (!asOf.ok) {
    return reportProblems(sink, asOf.problems);
  }
  const shape = parseShape(options.shape ?? 'text');
  if (!shape.ok) {
    return reportProblems(sink, shape.problems);
  }
  let advocate;
  if (options.advocate !== undefined) {
    const read = readAdvocateId(options.advocate);
    if (!read.ok) {
      return reportProblems(sink, read.problems);
    }
    advocate = read.value;
  }
  const rendered = runReport(
    session.context,
    catalog,
    name,
    { program: program.value, currency: currency.value, asOf: asOf.value, advocate },
    shape.value,
  );
  return emit(sink, rendered, (text) => text);
}

/** Run every report in one go, which is what the monthly pack actually needs. */
export function reportPackCommand(
  session: Session,
  catalog: Catalog,
  sink: Sink,
  options: ReportOptions,
): number {
  const skipped: string[] = [];
  for (const definition of definitions()) {
    if (definition.needsAdvocate && options.advocate === undefined) {
      skipped.push(definition.name);
      continue;
    }
    sink.out(`=== ${definition.name} ===`);
    const code = reportCommand(session, catalog, sink, definition.name, options);
    if (code !== EXIT_OK) {
      return code;
    }
    sink.out('');
  }
  if (skipped.length > 0) {
    sink.out(`skipped ${skipped.join(', ')}, they need an advocate`);
  }
  return EXIT_OK;
}

export function knownReport(name: string) {
  return reportNames().includes(name)
    ? ok(name)
    : fail('report_unknown', `no report called "${name}", try ${reportNames().join(', ')}`);
}

export function asOfLine(session: Session, options: ReportOptions): string {
  const asOf = asOfOf(session, options);
  return asOf.ok ? formatDay(asOf.value) : 'an unreadable day';
}
