/**
 * Releasing and paying a batch, and lifting a hold by hand.
 *
 * Only two hold reasons can be lifted at a desk: a payout under the minimum,
 * and missing remit details once somebody has gone and got them. Everything
 * else is a fact about the advocate's position and has to be answered by a
 * posting rather than by a decision.
 *
 * A release is recorded against the batch and it names who did it. That is the
 * whole audit requirement here, and it is cheap, so there is no excuse for the
 * release path to be the one that skips it.
 */

import { compareDays, formatDay, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, BatchId } from '../domain/identity.js';
import { isReleasable, type HoldReason } from '../domain/hold.js';
import { canMoveBatch, type BatchState, type SettlementLine } from '../domain/settlement.js';
import type { JournalDraft } from '../storage/journal.js';
import { requireDayText, type BatchRow } from '../storage/rows.js';
import type { Context } from './context.js';

export function batchById(context: Context, batch: BatchId): Result<BatchRow> {
  const row = context.store.batches.get(batch);
  return row === undefined ? fail('batch_unknown', `no batch ${batch}`) : ok(row);
}

function move(
  context: Context,
  batch: BatchId,
  to: BatchState,
  on: Day,
  kind: string,
  dayField: string,
): Result<JournalDraft[]> {
  const row = batchById(context, batch);
  if (!row.ok) {
    return row;
  }
  const from = row.value.state as BatchState;
  if (!canMoveBatch(from, to)) {
    return fail('batch_bad_transition', `a batch cannot go from ${from} to ${to}`);
  }
  const cutOn = requireDayText(row.value.cutOn, 'cutOn');
  if (!cutOn.ok) {
    return cutOn;
  }
  if (compareDays(on, cutOn.value) < 0) {
    return fail('batch_dated_too_early', `a batch cannot be ${to} before it was cut`);
  }
  return ok([
    {
      at: context.clock.now(),
      kind,
      key: batch,
      payload: { batch, [dayField]: formatDay(on), actor: context.actor },
    },
  ]);
}

export function releaseBatch(context: Context, batch: BatchId, on: Day): Result<JournalDraft[]> {
  return move(context, batch, 'released', on, 'batch_released', 'releasedOn');
}

export function payBatch(context: Context, batch: BatchId, on: Day): Result<JournalDraft[]> {
  return move(context, batch, 'paid', on, 'batch_paid', 'paidOn');
}

export interface ManualRelease {
  readonly advocate: AdvocateId;
  readonly lifted: readonly HoldReason[];
  readonly reason: string;
}

/**
 * Whether a desk may lift the hold on a line. Every reason on the line has to
 * be one a desk is allowed to lift, so a line held for two reasons where only
 * one is liftable stays held.
 */
export function canLiftByHand(line: SettlementLine): boolean {
  return line.hold.held && line.hold.reasons.every(isReleasable);
}

export function liftHold(
  context: Context,
  batch: BatchId,
  line: SettlementLine,
  reason: string,
): Result<JournalDraft[]> {
  if (!line.hold.held) {
    return fail('hold_not_held', 'this line is not held');
  }
  if (!canLiftByHand(line)) {
    const stuck = line.hold.reasons.filter((held) => !isReleasable(held));
    return fail('hold_not_liftable', `a desk cannot lift ${stuck.join(', ')}`);
  }
  if (reason.trim() === '') {
    return fail('hold_reason_missing', 'lifting a hold has to say why');
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'eligibility_flag_cleared',
      key: line.advocate,
      payload: {
        advocate: line.advocate,
        flag: `hold_lifted_on_${batch}`,
        clearedOn: formatDay(context.clock.today()),
        lifted: line.hold.reasons.join(','),
        note: reason,
        actor: context.actor,
      },
    },
  ]);
}

export function liftableLines(lines: readonly SettlementLine[]): SettlementLine[] {
  return lines.filter(canLiftByHand);
}

export function stuckLines(lines: readonly SettlementLine[]): SettlementLine[] {
  return lines.filter((line) => line.hold.held && !canLiftByHand(line));
}
