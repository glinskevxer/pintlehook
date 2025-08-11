/**
 * The command implementations. Each one takes a session, a sink and its own
 * options, and gives back an exit code.
 *
 * Commander is wired to these in the entry point and nowhere else, so every
 * command can be run in a test with a recording sink and a fixed clock. A
 * command that can only be exercised by spawning a process is a command nobody
 * tests, and the settlement run is not the place to find that out.
 */

import { formatDay, parseDay } from '../util/clock.js';
import { isCurrency, type Currency } from '../util/money.js';
import { fail, ok, type Result } from '../util/result.js';
import { readAdvocateId, readProgramId } from '../domain/identity.js';
import { runIntegrity } from '../storage/integrity.js';
import { trailForAdvocate, trailIsTrustworthy, describeEntry } from '../service/auditTrail.js';
import type { Catalog } from '../service/catalog.js';
import { programById, rulesFor } from '../service/catalog.js';
import { buildExceptions } from '../service/exceptionService.js';
import { exceptionReport } from '../report/exceptions.js';
import { renderText } from '../report/table.js';
import { EXIT_OK, emit, emitLines, reportProblems, type Sink } from './output.js';
import { saveSession, sessionSummary, type Session } from './session.js';

export interface CommonOptions {
  readonly program?: string | undefined;
  readonly currency?: string | undefined;
  readonly asOf?: string | undefined;
}

export function programOf(options: CommonOptions) {
  return options.program === undefined
    ? fail('option_missing', 'the program option is required', 'program')
    : readProgramId(options.program);
}

export function currencyOf(options: CommonOptions): Result<Currency> {
  const raw = options.currency ?? 'USD';
  return isCurrency(raw) ? ok(raw) : fail('option_currency_unsupported', `we do not carry ${raw}`);
}

export function asOfOf(session: Session, options: CommonOptions) {
  return options.asOf === undefined ? ok(session.context.clock.today()) : parseDay(options.asOf);
}

export function statusCommand(session: Session, sink: Sink): number {
  const integrity = runIntegrity(session.context.store);
  const lines = [
    sessionSummary(session),
    `journal verifies: ${trailIsTrustworthy(session.context) ? 'yes' : 'no'}`,
    `integrity: ${integrity.checksRun} checks, ${integrity.findings.length} findings`,
  ];
  for (const finding of integrity.findings.slice(0, 10)) {
    lines.push(`  ${finding.check} on ${finding.subject}: ${finding.detail}`);
  }
  return emitLines(sink, lines);
}

export function programsCommand(catalog: Catalog, sink: Sink): number {
  const lines = catalog.programs.map(
    (program) =>
      `${program.id}  ${program.name}  opened ${formatDay(program.openedOn)}  ${program.versions.length} versions`,
  );
  return emitLines(sink, lines.length === 0 ? ['no programs in the catalogue'] : lines);
}

export function rulesCommand(
  session: Session,
  catalog: Catalog,
  sink: Sink,
  options: CommonOptions,
): number {
  const program = programOf(options);
  if (!program.ok) {
    return reportProblems(sink, program.problems);
  }
  const found = programById(catalog, program.value);
  if (!found.ok) {
    return reportProblems(sink, found.problems);
  }
  const on = asOfOf(session, options);
  if (!on.ok) {
    return reportProblems(sink, on.problems);
  }
  const rules = rulesFor(catalog, program.value, on.value);
  return emit(sink, rules, (value) =>
    [
      `program ${program.value} on ${formatDay(on.value)}`,
      `  attribution window ${value.attributionWindowDays} days`,
      `  cure window ${value.cureWindowDays} days`,
      `  qualifying ${value.qualifyingLoadCount} loads in ${value.qualifyingWindowDays} days`,
      `  retention ${value.retentionDays} days`,
      `  currency ${value.currency}`,
    ].join('\n'),
  );
}

export function exceptionsCommand(
  session: Session,
  catalog: Catalog,
  sink: Sink,
  options: CommonOptions,
): number {
  const program = programOf(options);
  if (!program.ok) {
    return reportProblems(sink, program.problems);
  }
  const on = asOfOf(session, options);
  if (!on.ok) {
    return reportProblems(sink, on.problems);
  }
  const exceptions = buildExceptions(session.context, catalog, program.value);
  return emit(sink, exceptions, (value) => renderText(exceptionReport(value, on.value)));
}

export function auditCommand(session: Session, sink: Sink, advocate: string): number {
  const read = readAdvocateId(advocate);
  if (!read.ok) {
    return reportProblems(sink, read.problems);
  }
  const trail = trailForAdvocate(session.context, read.value);
  return emit(sink, trail, (entries) => entries.map(describeEntry).join('\n'));
}

export function saveCommand(session: Session, sink: Sink): number {
  const saved = saveSession(session);
  return emit(sink, saved, (sequence) => `wrote ${sequence} records`);
}

export function verifyCommand(session: Session, sink: Sink): number {
  const verified = session.context.store.journal.verify();
  if (!verified.ok) {
    return reportProblems(sink, verified.problems);
  }
  const integrity = runIntegrity(session.context.store);
  if (!integrity.clean) {
    return reportProblems(
      sink,
      integrity.findings.map((finding) => ({
        code: `integrity_${finding.check}`,
        message: `${finding.subject}: ${finding.detail}`,
      })),
    );
  }
  sink.out(`${verified.value} records verify and ${integrity.checksRun} checks are clean`);
  return EXIT_OK;
}
