/**
 * The accrual engine. It runs the ladder over one advocate's program year and
 * posts the difference between what the ladder says they are owed and what has
 * already been posted.
 *
 * Working in differences rather than in fresh postings is what makes the engine
 * safe to run twice, and safe to run after a reversal. Running it again on an
 * unchanged year posts nothing. Running it after a referral is reversed posts
 * the negative true ups that take the tier back down, and it does that without
 * a separate unwinding rule that could disagree with the ladder.
 */

import { compareDays, formatDay, type Day } from '../util/clock.js';
import { money, subtract, sum, zero, type Currency, type Money } from '../util/money.js';
import { byText, chain, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AccrualId, AdvocateId, ProgramId } from '../domain/identity.js';
import { runLadder, type LadderEntry, type LadderRun } from '../domain/ladder.js';
import type { JournalDraft } from '../storage/journal.js';
import { accrualsInProgramYear } from '../storage/repositories.js';
import type { AccrualRow } from '../storage/rows.js';
import { scheduleFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';

export interface QualifiedReferral {
  readonly referralKey: string;
  readonly qualifiedOn: Day;
  readonly margin: Money;
}

export interface AccrualRunRequest {
  readonly advocate: AdvocateId;
  readonly program: ProgramId;
  readonly programYearFrom: Day;
  readonly referrals: readonly QualifiedReferral[];
  readonly currency: Currency;
}

export interface AccrualPlan {
  readonly run: LadderRun;
  /** What the ladder says each referral is worth in total. */
  readonly target: ReadonlyMap<string, Money>;
  /** What is already on the books for each referral. */
  readonly posted: ReadonlyMap<string, Money>;
  readonly drafts: readonly JournalDraft[];
  readonly netChange: Money;
}

const entryOrder = chain(
  (left: QualifiedReferral, right: QualifiedReferral) =>
    compareDays(left.qualifiedOn, right.qualifiedOn),
  (left: QualifiedReferral, right: QualifiedReferral) =>
    byText(left.referralKey, right.referralKey),
);

export function ladderEntriesOf(referrals: readonly QualifiedReferral[]): LadderEntry[] {
  return sorted(referrals, entryOrder).map((referral) => ({
    key: referral.referralKey,
    qualifiedOn: referral.qualifiedOn,
    margin: referral.margin,
  }));
}

function postedByReferral(rows: readonly AccrualRow[], currency: Currency): Map<string, Money> {
  const totals = new Map<string, Money>();
  for (const row of rows) {
    const held = totals.get(row.referralKey) ?? zero(currency);
    totals.set(row.referralKey, money(currency, held.minor + row.amountMinor));
  }
  return totals;
}

export function planAccruals(
  context: Context,
  catalog: Catalog,
  request: AccrualRunRequest,
): Result<AccrualPlan> {
  const schedule = scheduleFor(catalog, request.program, request.programYearFrom);
  if (!schedule.ok) {
    return schedule;
  }
  if (schedule.value.currency !== request.currency) {
    return fail(
      'accrual_currency_mismatch',
      `the schedule pays ${schedule.value.currency} and the run is in ${request.currency}`,
    );
  }
  const foreign = request.referrals.find(
    (referral) => referral.margin.currency !== request.currency,
  );
  if (foreign !== undefined) {
    return fail(
      'accrual_currency_mismatch',
      `referral ${foreign.referralKey} carries ${foreign.margin.currency}`,
    );
  }
  const run = runLadder(schedule.value, ladderEntriesOf(request.referrals));
  if (!run.ok) {
    return run;
  }
  const target = new Map<string, Money>();
  for (const posting of run.value.postings) {
    const held = target.get(posting.key) ?? zero(request.currency);
    target.set(posting.key, money(request.currency, held.minor + posting.amount.minor));
  }
  const already = postedByReferral(
    accrualsInProgramYear(context.store, request.advocate, formatDay(request.programYearFrom)),
    request.currency,
  );
  const keys = sorted([...new Set([...target.keys(), ...already.keys()])], byText);
  const drafts: JournalDraft[] = [];
  const changes: Money[] = [];
  for (const key of keys) {
    const wanted = target.get(key) ?? zero(request.currency);
    const held = already.get(key) ?? zero(request.currency);
    const difference = subtract(wanted, held);
    if (difference.minor === 0) {
      continue;
    }
    changes.push(difference);
    const id = context.ids.mint('accrual') as AccrualId;
    drafts.push({
      at: context.clock.now(),
      kind: 'accrual_posted',
      key: id,
      payload: {
        accrual: id,
        advocate: request.advocate,
        program: request.program,
        referralKey: key,
        kind: kindOfChange(held, difference),
        postedOn: formatDay(context.clock.today()),
        programYearFrom: formatDay(request.programYearFrom),
        amountMinor: difference.minor,
        currency: request.currency,
        reverses: '',
        note: noteFor(held, difference),
        actor: context.actor,
      },
    });
  }
  return ok({
    run: run.value,
    target,
    posted: already,
    drafts,
    netChange: sum(changes, request.currency),
  });
}

function kindOfChange(alreadyPosted: Money, difference: Money): string {
  if (alreadyPosted.minor === 0) {
    return 'base';
  }
  return difference.minor > 0 ? 'true_up' : 'true_down';
}

function noteFor(alreadyPosted: Money, difference: Money): string {
  if (alreadyPosted.minor === 0) {
    return 'first posting for this referral';
  }
  return difference.minor > 0 ? 'tier crossing true up' : 'tier fell back, true down';
}

export function isSettled(plan: AccrualPlan): boolean {
  return plan.drafts.length === 0;
}

export function describePlan(plan: AccrualPlan): string {
  return isSettled(plan)
    ? 'nothing to post'
    : `${plan.drafts.length} postings, net ${plan.netChange.minor} minor units`;
}

export function runAccruals(
  context: Context,
  catalog: Catalog,
  request: AccrualRunRequest,
): Result<AccrualPlan> {
  const plan = planAccruals(context, catalog, request);
  if (!plan.ok) {
    return plan;
  }
  if (plan.value.drafts.length === 0) {
    return plan;
  }
  const committed = context.store.commit(plan.value.drafts);
  return committed.ok ? plan : committed;
}
