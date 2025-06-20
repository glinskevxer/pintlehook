/**
 * Lane analysis. Which lanes the invited carriers actually ran, what they
 * earned on them, and how that compares with the lanes the referring advocate
 * runs.
 *
 * The comparison is the useful part. A referral programme that keeps bringing
 * in carriers who run the same three lanes as the advocate who referred them is
 * buying capacity the brokerage already had, and the only way to see that is to
 * put the two lane sets side by side.
 */

import { money, sum, type Currency, type Money } from '../util/money.js';
import { byText, sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId, ProgramId } from '../domain/identity.js';
import { grossMargin, laneKey } from '../domain/load.js';
import type { Context } from '../service/context.js';
import { loadOf } from '../service/qualificationService.js';
import { advocateById, loadsOfCarrier, referralsOfAdvocate } from '../storage/repositories.js';
import { moneyColumn, numberColumn, textColumn, type Report } from './table.js';

export interface LaneRow {
  readonly lane: string;
  readonly loads: number;
  readonly margin: Money;
  readonly averageMargin: Money;
}

/**
 * Both lane readers were building the same map and then turning it into the
 * same rows, and the average was computed twice in two places that could drift.
 * One tally, one place that divides.
 */
class LaneTally {
  private readonly counts = new Map<string, { loads: number; minor: number }>();

  add(lane: string, loads: number, minor: number): void {
    const held = this.counts.get(lane) ?? { loads: 0, minor: 0 };
    held.loads += loads;
    held.minor += minor;
    this.counts.set(lane, held);
  }

  rows(currency: Currency): LaneRow[] {
    const rows = [...this.counts.entries()].map(([lane, held]) => ({
      lane,
      loads: held.loads,
      margin: money(currency, held.minor),
      averageMargin: money(currency, held.loads === 0 ? 0 : Math.trunc(held.minor / held.loads)),
    }));
    return sorted(rows, (left, right) => byText(left.lane, right.lane));
  }
}

export function lanesForCarrier(
  context: Context,
  carrier: string,
  currency: Currency,
): Result<LaneRow[]> {
  const tally = new LaneTally();
  for (const row of loadsOfCarrier(context.store, carrier)) {
    const load = loadOf(row);
    if (!load.ok) {
      return load;
    }
    if (load.value.status !== 'delivered') {
      continue;
    }
    tally.add(laneKey(load.value.lane), 1, grossMargin(load.value).minor);
  }
  return ok(tally.rows(currency));
}

export function lanesForInvitees(
  context: Context,
  advocate: AdvocateId,
  program: ProgramId,
  currency: Currency,
): Result<LaneRow[]> {
  const tally = new LaneTally();
  for (const referral of referralsOfAdvocate(context.store, advocate)) {
    if (referral.program !== program) {
      continue;
    }
    const lanes = lanesForCarrier(context, referral.invitee, currency);
    if (!lanes.ok) {
      return lanes;
    }
    for (const lane of lanes.value) {
      tally.add(lane.lane, lane.loads, lane.margin.minor);
    }
  }
  return ok(tally.rows(currency));
}

export interface LaneOverlap {
  readonly shared: readonly string[];
  readonly newLanes: readonly string[];
  readonly overlapShare: number;
}

export function overlapOf(
  advocateLanes: readonly LaneRow[],
  inviteeLanes: readonly LaneRow[],
): LaneOverlap {
  const mine = new Set(advocateLanes.map((row) => row.lane));
  const shared: string[] = [];
  const newLanes: string[] = [];
  for (const row of inviteeLanes) {
    if (mine.has(row.lane)) {
      shared.push(row.lane);
    } else {
      newLanes.push(row.lane);
    }
  }
  const total = shared.length + newLanes.length;
  return {
    shared: shared.sort(),
    newLanes: newLanes.sort(),
    overlapShare: total === 0 ? 0 : shared.length / total,
  };
}

export function laneReport(
  rows: readonly LaneRow[],
  title: string,
  currency: Currency,
): Report<LaneRow> {
  const total = sum(
    rows.map((row) => row.margin),
    currency,
  );
  return {
    title,
    columns: [
      textColumn<LaneRow>('lane', 'lane', (row) => row.lane),
      numberColumn<LaneRow>('loads', 'loads', (row) => row.loads),
      moneyColumn<LaneRow>('margin', 'margin', (row) => row.margin),
      moneyColumn<LaneRow>('average', 'average', (row) => row.averageMargin),
    ],
    rows,
    footnotes: [`${rows.length} lanes carrying ${total.minor} minor units`],
  };
}

export function advocateLanes(
  context: Context,
  advocate: AdvocateId,
  currency: Currency,
): Result<LaneRow[]> {
  const row = advocateById(context.store, advocate);
  return row.ok ? lanesForCarrier(context, row.value.carrier, currency) : row;
}
