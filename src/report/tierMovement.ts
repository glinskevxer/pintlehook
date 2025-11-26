/**
 * Tier movement. Which advocates crossed a rung this period and which fell back
 * down one.
 *
 * The register shows money and the statement shows postings, and neither of
 * them answers the question the program manager actually asks at the end of a
 * month, which is who moved. A true up on a statement says the tier changed but
 * not from what to what, and reading that off a list of amounts is the sort of
 * arithmetic somebody gets wrong once a quarter.
 */

import { compareDays, formatDay, type Day } from '../util/clock.js';
import { byText, sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId, ProgramId } from '../domain/identity.js';
import { standingAt } from '../domain/ladder.js';
import type { DayInterval } from '../util/interval.js';
import { contains } from '../util/interval.js';
import { scheduleFor, type Catalog } from '../service/catalog.js';
import type { Context } from '../service/context.js';
import { enrolledAdvocates, referralsOfAdvocate } from '../storage/repositories.js';
import { NO_DAY, readDayText } from '../storage/rows.js';
import { numberColumn, textColumn, type Report } from './table.js';

export type Direction = 'climbed' | 'fell' | 'held';

export interface MovementRow {
  readonly advocate: string;
  readonly before: string;
  readonly after: string;
  readonly countBefore: number;
  readonly countAfter: number;
  readonly direction: Direction;
}

/** Qualified referrals an advocate held on a day, counted from the referral rows. */
export function countOn(
  context: Context,
  advocate: AdvocateId,
  program: ProgramId,
  on: Day,
): Result<number> {
  let count = 0;
  for (const row of referralsOfAdvocate(context.store, advocate)) {
    if (row.program !== program || row.qualifiedOn === NO_DAY) {
      continue;
    }
    const qualifiedOn = readDayText(row.qualifiedOn, 'qualifiedOn');
    if (!qualifiedOn.ok) {
      return qualifiedOn;
    }
    if (qualifiedOn.value === undefined || compareDays(qualifiedOn.value, on) > 0) {
      continue;
    }
    if (row.state === 'reversed' && row.reversedOn !== NO_DAY) {
      const reversedOn = readDayText(row.reversedOn, 'reversedOn');
      if (!reversedOn.ok) {
        return reversedOn;
      }
      if (reversedOn.value !== undefined && compareDays(reversedOn.value, on) <= 0) {
        continue;
      }
    }
    count += 1;
  }
  return ok(count);
}

function directionOf(before: number, after: number): Direction {
  if (after > before) {
    return 'climbed';
  }
  return after < before ? 'fell' : 'held';
}

export function movementOver(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
  period: DayInterval,
): Result<MovementRow[]> {
  const schedule = scheduleFor(catalog, program, period.from);
  if (!schedule.ok) {
    return schedule;
  }
  const rows: MovementRow[] = [];
  for (const advocate of enrolledAdvocates(context.store, program)) {
    const id = advocate.id as AdvocateId;
    const before = countOn(context, id, program, period.from);
    if (!before.ok) {
      return before;
    }
    const after = countOn(context, id, program, period.until);
    if (!after.ok) {
      return after;
    }
    const namedBefore = standingAt(schedule.value, before.value);
    const namedAfter = standingAt(schedule.value, after.value);
    if (namedBefore === namedAfter) {
      continue;
    }
    rows.push({
      advocate: advocate.id,
      before: namedBefore,
      after: namedAfter,
      countBefore: before.value,
      countAfter: after.value,
      direction: directionOf(before.value, after.value),
    });
  }
  return ok(sorted(rows, (left, right) => byText(left.advocate, right.advocate)));
}

export function movementReport(
  rows: readonly MovementRow[],
  period: DayInterval,
): Report<MovementRow> {
  const climbed = rows.filter((row) => row.direction === 'climbed').length;
  const fell = rows.filter((row) => row.direction === 'fell').length;
  return {
    title: `tier movement over ${formatDay(period.from)} to ${formatDay(period.until)}`,
    columns: [
      textColumn<MovementRow>('advocate', 'advocate', (row) => row.advocate),
      textColumn<MovementRow>('before', 'from', (row) => row.before),
      textColumn<MovementRow>('after', 'to', (row) => row.after),
      numberColumn<MovementRow>('countBefore', 'was', (row) => row.countBefore),
      numberColumn<MovementRow>('countAfter', 'now', (row) => row.countAfter),
      textColumn<MovementRow>('direction', 'way', (row) => row.direction),
    ],
    rows,
    footnotes: [
      `${climbed} climbed, ${fell} fell back`,
      'only advocates whose rung changed are listed',
    ],
  };
}

export function inPeriod(period: DayInterval, on: Day): boolean {
  return contains(period, on);
}
