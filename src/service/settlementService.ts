/**
 * Cutting a settlement batch.
 *
 * The line for an advocate is built from the accruals that fall in the period,
 * but the amount it pays is the whole unsettled position, because a true down
 * posted this period can answer a bounty paid two periods ago. The register
 * prints both numbers and they are expected to differ.
 *
 * The hold rules run last and they read only the settlement stream. Nothing
 * here tells them about attribution or the cure window, and yet a change to
 * either of those moves the held count, because it moves what the position is.
 */

import { compareDays, formatDay, type Day } from '../util/clock.js';
import { contains, type DayInterval } from '../util/interval.js';
import { money, sum, type Currency, type Money } from '../util/money.js';
import { byText, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Accrual, AccrualKind } from '../domain/accrual.js';
import type {
  AccrualId,
  AdvocateId,
  BatchId,
  ProgramId,
  SettlementId,
} from '../domain/identity.js';
import { assessHold, type HoldVerdict } from '../domain/hold.js';
import { buildLine, type SettlementBatch, type SettlementLine } from '../domain/settlement.js';
import {
  applyToSettlement,
  emptyBalance,
  fromMinor,
  type RecoveryPolicy,
} from '../domain/recovery.js';
import type { JournalDraft } from '../storage/journal.js';
import {
  accrualsInProgramYear,
  accrualsOfAdvocate,
  enrolledAdvocates,
  openFlagsOf,
} from '../storage/repositories.js';
import { readDayText, requireDayText, type AccrualRow } from '../storage/rows.js';
import { rulesFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';

export const DEFAULT_MINIMUM_PAYOUT_MINOR = 5_000;
export const DEFAULT_WITHHOLDING_SHARE = 5000;

export interface SettlementRequest {
  readonly program: ProgramId;
  readonly period: DayInterval;
  readonly cutOn: Day;
  readonly currency: Currency;
  readonly minimumPayoutMinor?: number | undefined;
  readonly withholdingShare?: number | undefined;
  /** Accruals already settled in an earlier batch. */
  readonly settledAccrualIds?: ReadonlySet<string> | undefined;
  /** The program year the cap is measured over, defaulting to the period start. */
  readonly programYearFrom?: Day | undefined;
}

export interface SettlementPlan {
  readonly batch: SettlementBatch;
  readonly drafts: readonly JournalDraft[];
  readonly heldCount: number;
  readonly payableTotal: Money;
  readonly withheldTotal: Money;
}

function accrualOf(row: AccrualRow, currency: Currency): Result<Accrual> {
  const postedOn = requireDayText(row.postedOn, 'postedOn');
  if (!postedOn.ok) {
    return postedOn;
  }
  const programYearFrom = requireDayText(row.programYearFrom, 'programYearFrom');
  if (!programYearFrom.ok) {
    return programYearFrom;
  }
  return ok({
    id: row.id as AccrualId,
    advocate: row.advocate as AdvocateId,
    program: row.program as ProgramId,
    referralKey: row.referralKey,
    kind: row.kind as AccrualKind,
    postedOn: postedOn.value,
    programYearFrom: programYearFrom.value,
    amount: money(currency, row.amountMinor),
    reverses: row.reverses === '' ? undefined : (row.reverses as AccrualId),
    note: row.note,
  });
}

/**
 * Whether an advocate has taken as much out of this program year as the rules
 * allow. A cap of zero means there is no cap, which is how every version in the
 * catalogue has been written so far, and is exactly why this had to be wired
 * from the rules rather than assumed: a cap that is never exercised is a cap
 * nobody notices is dead.
 */
export function capReached(
  context: Context,
  advocate: AdvocateId,
  programYearFrom: Day,
  capMinor: number,
): boolean {
  if (capMinor <= 0) {
    return false;
  }
  const posted = accrualsInProgramYear(context.store, advocate, formatDay(programYearFrom)).reduce(
    (running, row) => running + row.amountMinor,
    0,
  );
  return posted >= capMinor;
}

export function cutBatch(
  context: Context,
  catalog: Catalog,
  request: SettlementRequest,
): Result<SettlementPlan> {
  if (compareDays(request.cutOn, request.period.until) < 0) {
    return fail('settlement_cut_too_early', 'a batch cannot be cut before its period closes');
  }
  const rules = rulesFor(catalog, request.program, request.period.from);
  if (!rules.ok) {
    return rules;
  }
  const settled = request.settledAccrualIds ?? new Set<string>();
  const recoveryPolicy: RecoveryPolicy = {
    withholdingShare: request.withholdingShare ?? DEFAULT_WITHHOLDING_SHARE,
    staleAfterDays: 90,
    currency: request.currency,
  };
  const minimum = money(
    request.currency,
    request.minimumPayoutMinor ?? DEFAULT_MINIMUM_PAYOUT_MINOR,
  );
  const batchId = context.ids.mint('batch') as BatchId;
  const lines: SettlementLine[] = [];

  for (const advocate of enrolledAdvocates(context.store, request.program)) {
    const inPeriod: Accrual[] = [];
    let positionMinor = 0;
    for (const row of accrualsOfAdvocate(context.store, advocate.id)) {
      if (row.currency !== request.currency) {
        return fail(
          'settlement_currency_mismatch',
          `accrual ${row.id} is in ${row.currency} and the batch pays ${request.currency}`,
        );
      }
      const on = readDayText(row.postedOn, 'postedOn');
      if (!on.ok) {
        return on;
      }
      if (on.value !== undefined && contains(request.period, on.value)) {
        const accrual = accrualOf(row, request.currency);
        if (!accrual.ok) {
          return accrual;
        }
        inPeriod.push(accrual.value);
      }
      if (!settled.has(row.id)) {
        positionMinor += row.amountMinor;
      }
    }
    if (inPeriod.length === 0 && positionMinor === 0) {
      continue;
    }
    const position = money(request.currency, positionMinor);
    const balance =
      positionMinor < 0
        ? fromMinor(request.currency, -positionMinor, request.cutOn)
        : emptyBalance(request.currency);
    const applied = applyToSettlement(
      balance,
      money(request.currency, Math.max(positionMinor, 0)),
      recoveryPolicy,
      request.cutOn,
    );
    if (!applied.ok) {
      return applied;
    }
    const hold: HoldVerdict = assessHold({
      netPosition: position,
      recoveryOutstanding: balance.outstanding,
      releaseCeiling: money(request.currency, rules.value.releaseCeilingMinor),
      minimumPayout: minimum,
      openEligibilityFlags: openFlagsOf(context.store, advocate.id),
      hasRemitDetails: true,
      programYearCapReached: capReached(
        context,
        advocate.id as AdvocateId,
        request.programYearFrom ?? request.period.from,
        rules.value.programYearCapMinor,
      ),
      asOf: request.cutOn,
    });
    const line = buildLine(
      context.ids.mint('settlement') as SettlementId,
      advocate.id as AdvocateId,
      inPeriod,
      position,
      applied.value.withheld,
      hold,
      request.currency,
    );
    if (!line.ok) {
      return line;
    }
    lines.push(line.value);
  }

  const ordered = sorted(lines, (left, right) => byText(left.advocate, right.advocate));
  const batch: SettlementBatch = {
    id: batchId,
    period: request.period,
    cutOn: request.cutOn,
    state: 'cut',
    currency: request.currency,
    lines: ordered,
  };
  return ok({
    batch,
    drafts: batchDrafts(context, batch),
    heldCount: ordered.filter((line) => line.hold.held).length,
    payableTotal: sum(
      ordered.map((line) => line.payable),
      request.currency,
    ),
    withheldTotal: sum(
      ordered.map((line) => line.withheld),
      request.currency,
    ),
  });
}

function batchDrafts(context: Context, batch: SettlementBatch): JournalDraft[] {
  return [
    {
      at: context.clock.now(),
      kind: 'batch_cut',
      key: batch.id,
      payload: {
        batch: batch.id,
        periodFrom: formatDay(batch.period.from),
        periodUntil: formatDay(batch.period.until),
        cutOn: formatDay(batch.cutOn),
        currency: batch.currency,
        lineCount: batch.lines.length,
        actor: context.actor,
      },
    },
  ];
}

/** The accruals a batch actually settles, which is the ones on unheld lines. */
export function settledIdsOf(batch: SettlementBatch): Set<string> {
  const ids = new Set<string>();
  for (const line of batch.lines) {
    if (line.hold.held) {
      continue;
    }
    for (const id of line.accrualIds) {
      ids.add(id);
    }
  }
  return ids;
}

export function lineFor(batch: SettlementBatch, advocate: AdvocateId): SettlementLine | undefined {
  return batch.lines.find((line) => line.advocate === advocate);
}
