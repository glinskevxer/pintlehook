/**
 * A load is the qualifying event. Nothing in this program pays on a signup, so
 * the load record is where the money the brokerage actually made shows up, and
 * the margin on it is what a tier with a margin share is a share of.
 *
 * A load counts once it is delivered and the paperwork is in. Delivered and
 * billable are different days and the program uses delivery, because a slow
 * billing desk should not move a carrier out of their qualifying window.
 */

import { compareDays, type Day } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { money, subtract, type Currency, type Money } from '../util/money.js';
import { ascending, byKey, byText, chain } from '../util/ordering.js';
import type { Comparator } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { CarrierId, LoadId } from './identity.js';

export type LoadStatus = 'delivered' | 'cancelled' | 'refused' | 'in_transit';

export interface Lane {
  readonly originState: string;
  readonly destinationState: string;
}

export interface Load {
  readonly id: LoadId;
  readonly carrier: CarrierId;
  readonly status: LoadStatus;
  readonly deliveredOn?: Day | undefined;
  readonly billedOn?: Day | undefined;
  readonly lane: Lane;
  /** What the shipper pays the brokerage. */
  readonly lineHaulMinor: number;
  /** What the brokerage pays the carrier. */
  readonly carrierPayMinor: number;
  readonly currency: Currency;
  readonly proNumber: string;
}

export function isDelivered(load: Load): boolean {
  return load.status === 'delivered' && load.deliveredOn !== undefined;
}

export function grossMargin(load: Load): Money {
  return subtract(
    money(load.currency, load.lineHaulMinor),
    money(load.currency, load.carrierPayMinor),
  );
}

export function marginIsNegative(load: Load): boolean {
  return grossMargin(load).minor < 0;
}

export function isInterstate(load: Load): boolean {
  return load.lane.originState !== load.lane.destinationState;
}

export function laneKey(lane: Lane): string {
  return `${lane.originState.toUpperCase()}-${lane.destinationState.toUpperCase()}`;
}

export function loadNaturalKey(load: Load): string {
  return digestOfParts([load.carrier, load.proNumber.trim().toUpperCase()]);
}

/** Delivered date first, then pro number, so two loads never tie. */
export const loadOrder: Comparator<Load> = chain(
  byKey((l: Load) => (l.deliveredOn === undefined ? 0 : 1), ascending),
  byKey((l: Load) => l.deliveredOn ?? { year: 0, month: 1, dayOfMonth: 1 }, compareDays),
  byKey((l: Load) => l.proNumber, byText),
);

export function validateLoad(load: Load): Result<Load> {
  if (load.proNumber.trim() === '') {
    return fail('load_pro_missing', 'a load needs a pro number');
  }
  if (!Number.isSafeInteger(load.lineHaulMinor) || !Number.isSafeInteger(load.carrierPayMinor)) {
    return fail('load_amount_not_integer', 'load amounts are held in whole minor units');
  }
  if (load.lineHaulMinor < 0 || load.carrierPayMinor < 0) {
    return fail('load_amount_negative', 'a load cannot carry a negative amount');
  }
  if (!/^[A-Z]{2}$/.test(load.lane.originState) || !/^[A-Z]{2}$/.test(load.lane.destinationState)) {
    return fail('load_lane_shape', 'a lane is two upper case state codes');
  }
  if (load.status === 'delivered' && load.deliveredOn === undefined) {
    return fail('load_delivered_without_day', 'a delivered load has to carry the day it delivered');
  }
  if (load.status !== 'delivered' && load.deliveredOn !== undefined) {
    return fail('load_undelivered_with_day', 'only a delivered load carries a delivery day');
  }
  if (
    load.deliveredOn !== undefined &&
    load.billedOn !== undefined &&
    compareDays(load.billedOn, load.deliveredOn) < 0
  ) {
    return fail('load_billed_before_delivery', 'a load cannot be billed before it delivered');
  }
  return ok(load);
}

export function describeLoad(load: Load): string {
  return `${load.proNumber} ${laneKey(load.lane)} ${load.status}`;
}
