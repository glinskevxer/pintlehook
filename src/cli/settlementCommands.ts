/**
 * Settlement from the command line. Cutting, previewing, and moving a batch
 * along.
 *
 * Cut defaults to a preview. Somebody typing a settlement command at half past
 * five on a Friday should have to say they meant it, and the flag that makes it
 * real is spelled out rather than a single letter.
 */

import { formatDay, parseDay } from '../util/clock.js';
import { interval } from '../util/interval.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Day } from '../util/clock.js';
import { readBatchId } from '../domain/identity.js';
import { registerReport, summarize } from '../report/register.js';
import { renderText } from '../report/table.js';
import type { Catalog } from '../service/catalog.js';
import { payBatch, releaseBatch } from '../service/releaseService.js';
import { cutBatch } from '../service/settlementService.js';
import { readCommon, type CommonOptions } from './commands.js';
import { EXIT_OK, emit, reportProblems, type Sink } from './output.js';
import type { Session } from './session.js';

export interface CutOptions extends CommonOptions {
  readonly from?: string | undefined;
  readonly until?: string | undefined;
  readonly commit?: boolean | undefined;
}

function requiredDay(raw: string | undefined, field: string): Result<Day> {
  return raw === undefined
    ? fail('option_missing', `the ${field} option is required`, field)
    : parseDay(raw);
}

export function cutCommand(
  session: Session,
  catalog: Catalog,
  sink: Sink,
  options: CutOptions,
): number {
  const common = readCommon(session, options);
  if (!common.ok) {
    return reportProblems(sink, common.problems);
  }
  const from = requiredDay(options.from, 'from');
  if (!from.ok) {
    return reportProblems(sink, from.problems);
  }
  const until = requiredDay(options.until, 'until');
  if (!until.ok) {
    return reportProblems(sink, until.problems);
  }
  const plan = cutBatch(session.context, catalog, {
    program: common.value.program,
    period: interval(from.value, until.value),
    cutOn: common.value.asOf,
    currency: common.value.currency,
  });
  if (!plan.ok) {
    return reportProblems(sink, plan.problems);
  }
  const summary = summarize(plan.value.batch);
  sink.out(renderText(registerReport(plan.value.batch)));
  if (options.commit !== true) {
    sink.out('');
    sink.out('this was a preview, pass the commit flag to cut it for real');
    return EXIT_OK;
  }
  const written = session.context.store.commit([...plan.value.drafts]);
  if (!written.ok) {
    return reportProblems(sink, written.problems);
  }
  sink.out('');
  sink.out(
    `cut ${plan.value.batch.id} with ${summary.lines} lines, ${summary.held} held, ${summary.payable.minor} minor units payable`,
  );
  return EXIT_OK;
}

export function releaseCommand(
  session: Session,
  sink: Sink,
  batch: string,
  on: string | undefined,
): number {
  return moveCommand(session, sink, batch, on, releaseBatch, 'released');
}

export function payCommand(
  session: Session,
  sink: Sink,
  batch: string,
  on: string | undefined,
): number {
  return moveCommand(session, sink, batch, on, payBatch, 'paid');
}

function moveCommand(
  session: Session,
  sink: Sink,
  batch: string,
  on: string | undefined,
  move: typeof releaseBatch,
  word: string,
): number {
  const id = readBatchId(batch);
  if (!id.ok) {
    return reportProblems(sink, id.problems);
  }
  const day = on === undefined ? ok(session.context.clock.today()) : parseDay(on);
  if (!day.ok) {
    return reportProblems(sink, day.problems);
  }
  const drafts = move(session.context, id.value, day.value);
  if (!drafts.ok) {
    return reportProblems(sink, drafts.problems);
  }
  const written = session.context.store.commit(drafts.value);
  return emit(sink, written, () => `${batch} ${word} on ${formatDay(day.value)}`);
}

export function batchesCommand(session: Session, sink: Sink, state: string | undefined): number {
  const rows = session.context.store.batches
    .where((row) => state === undefined || row.state === state)
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  if (rows.length === 0) {
    sink.out(state === undefined ? 'no batches' : `no batches in ${state}`);
    return EXIT_OK;
  }
  for (const row of rows) {
    sink.out(
      `${row.id}  ${row.state.padEnd(9)}cut ${row.cutOn}  ${row.periodFrom} to ${row.periodUntil}`,
    );
  }
  return EXIT_OK;
}
