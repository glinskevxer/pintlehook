/**
 * Retention. A bounty is at risk until the invited carrier has stayed with the
 * brokerage for the retention window, and staying means hauling rather than
 * merely not resigning.
 *
 * The window is cut into checkpoints and every checkpoint has to contain a
 * delivered load. That is stricter than a single gap rule and it is what the
 * settlement desk actually wants, because a carrier who runs three loads in
 * week one and nothing for four months has not been retained.
 */

import { addDays, compareDays, isBefore, type Day } from '../util/clock.js';
import {
  contains,
  intervalOfLength,
  splitIntoPeriods,
  type DayInterval,
} from '../util/interval.js';
import { fail, ok, type Result } from '../util/result.js';
import { isDelivered, type Load } from './load.js';

export type RetentionState = 'holding' | 'satisfied' | 'failed';

export interface RetentionCheckpoint {
  readonly period: DayInterval;
  readonly deliveries: number;
  readonly closed: boolean;
}

export interface RetentionAssessment {
  readonly state: RetentionState;
  readonly window: DayInterval;
  readonly checkpoints: readonly RetentionCheckpoint[];
  readonly firstEmptyClosedCheckpoint?: DayInterval | undefined;
  readonly lastDeliveryOn?: Day | undefined;
  readonly failedOn?: Day | undefined;
}

export interface RetentionInput {
  readonly loads: readonly Load[];
  readonly qualifiedOn: Day;
  readonly retentionDays: number;
  readonly checkpointDays: number;
  readonly asOf: Day;
  /** Set when the carrier lost operating authority inside the window. */
  readonly authorityLostOn?: Day | undefined;
}

export function retentionWindow(qualifiedOn: Day, retentionDays: number): Result<DayInterval> {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    return fail(
      'retention_window_length',
      'the retention window must be a positive whole number of days',
    );
  }
  return ok(intervalOfLength(qualifiedOn, retentionDays));
}

export function assessRetention(input: RetentionInput): Result<RetentionAssessment> {
  const window = retentionWindow(input.qualifiedOn, input.retentionDays);
  if (!window.ok) {
    return window;
  }
  if (!Number.isInteger(input.checkpointDays) || input.checkpointDays <= 0) {
    return fail(
      'retention_checkpoint_length',
      'a checkpoint must be a positive whole number of days',
    );
  }
  const periods = splitIntoPeriods(window.value, input.checkpointDays);
  const delivered = input.loads.filter(
    (load) => isDelivered(load) && load.deliveredOn !== undefined,
  );
  const checkpoints: RetentionCheckpoint[] = periods.map((period) => ({
    period,
    deliveries: delivered.filter((load) => contains(period, load.deliveredOn as Day)).length,
    closed: !isBefore(input.asOf, period.until),
  }));
  const lastDeliveryOn = delivered
    .map((load) => load.deliveredOn as Day)
    .sort(compareDays)
    .at(-1);

  if (input.authorityLostOn !== undefined && contains(window.value, input.authorityLostOn)) {
    return ok({
      state: 'failed',
      window: window.value,
      checkpoints,
      failedOn: input.authorityLostOn,
      lastDeliveryOn,
    });
  }
  const firstEmpty = checkpoints.find(
    (checkpoint) => checkpoint.closed && checkpoint.deliveries === 0,
  );
  if (firstEmpty !== undefined) {
    return ok({
      state: 'failed',
      window: window.value,
      checkpoints,
      firstEmptyClosedCheckpoint: firstEmpty.period,
      failedOn: addDays(firstEmpty.period.until, -1),
      lastDeliveryOn,
    });
  }
  const windowClosed = !isBefore(input.asOf, window.value.until);
  return ok({
    state: windowClosed ? 'satisfied' : 'holding',
    window: window.value,
    checkpoints,
    lastDeliveryOn,
  });
}

export function isAtRisk(assessment: RetentionAssessment): boolean {
  return assessment.state === 'holding';
}

export function describeRetention(assessment: RetentionAssessment): string {
  switch (assessment.state) {
    case 'satisfied':
      return 'retention satisfied';
    case 'holding':
      return `retention holding over ${assessment.checkpoints.length} checkpoints`;
    case 'failed':
      return assessment.firstEmptyClosedCheckpoint === undefined
        ? 'retention failed on lost authority'
        : 'retention failed on an empty checkpoint';
  }
}
