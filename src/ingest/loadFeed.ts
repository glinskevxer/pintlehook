/**
 * The load feed. One row per load out of the transportation management system,
 * and it is the only feed that carries money.
 *
 * The line haul and the carrier pay arrive as separate columns and the margin
 * is never trusted from the file, because the operations system computes it on
 * a different rounding than the settlement system and the two have disagreed by
 * a cent often enough to matter.
 */

import type { Day } from '../util/clock.js';
import { parseMotorCarrierNumber } from '../util/ids.js';
import type { Currency } from '../util/money.js';
import { err, ok, type Problem, type Result } from '../util/result.js';
import type { Lane, LoadStatus } from '../domain/load.js';
import {
  readCurrency,
  readDay,
  readMinorUnits,
  readOneOf,
  readOptionalText,
  readText,
  type Row,
} from './coerce.js';
import type { FeedEnvelope } from './envelope.js';
import { readRows, rowReference, type FeedRead } from './feed.js';

const LOAD_STATUSES = ['delivered', 'cancelled', 'refused', 'in_transit'] as const;

export interface LoadDraft {
  readonly carrierMotorCarrierNumber: string;
  readonly proNumber: string;
  readonly status: LoadStatus;
  readonly deliveredOn?: Day | undefined;
  readonly billedOn?: Day | undefined;
  readonly lane: Lane;
  readonly lineHaulMinor: number;
  readonly carrierPayMinor: number;
  readonly currency: Currency;
  readonly sourceReference: string;
  readonly rowNumber: number;
}

export const LOAD_COLUMNS = [
  'carrier_mc',
  'pro_number',
  'status',
  'origin_state',
  'destination_state',
  'line_haul',
  'carrier_pay',
  'currency',
] as const;

function optionalDay(row: Row, column: string): Result<Day | undefined> {
  if (readOptionalText(row, column) === undefined) {
    return ok(undefined);
  }
  return readDay(row, column);
}

export function readLoadRow(
  envelope: FeedEnvelope,
  row: Row,
  rowNumber: number,
): Result<LoadDraft> {
  const carrier = readText(row, 'carrier_mc');
  const pro = readText(row, 'pro_number');
  const status = readOneOf(row, 'status', LOAD_STATUSES);
  const origin = readText(row, 'origin_state');
  const destination = readText(row, 'destination_state');
  const lineHaul = readMinorUnits(row, 'line_haul');
  const carrierPay = readMinorUnits(row, 'carrier_pay');
  const currency = readCurrency(row, 'currency');
  const deliveredOn = optionalDay(row, 'delivered_on');
  const billedOn = optionalDay(row, 'billed_on');
  const results = [
    carrier,
    pro,
    status,
    origin,
    destination,
    lineHaul,
    carrierPay,
    currency,
    deliveredOn,
    billedOn,
  ];
  if (
    !carrier.ok ||
    !pro.ok ||
    !status.ok ||
    !origin.ok ||
    !destination.ok ||
    !lineHaul.ok ||
    !carrierPay.ok ||
    !currency.ok ||
    !deliveredOn.ok ||
    !billedOn.ok
  ) {
    const problems: Problem[] = [];
    for (const result of results) {
      if (!result.ok) {
        problems.push(...result.problems);
      }
    }
    return err(problems);
  }
  const parsedCarrier = parseMotorCarrierNumber(carrier.value);
  if (!parsedCarrier.ok) {
    return err(parsedCarrier.problems.map((p) => ({ ...p, path: 'carrier_mc' })));
  }
  const lane: Lane = {
    originState: origin.value.toUpperCase(),
    destinationState: destination.value.toUpperCase(),
  };
  return ok({
    carrierMotorCarrierNumber: parsedCarrier.value,
    proNumber: pro.value.toUpperCase(),
    status: status.value,
    deliveredOn: deliveredOn.value,
    billedOn: billedOn.value,
    lane,
    lineHaulMinor: lineHaul.value,
    carrierPayMinor: carrierPay.value,
    currency: currency.value,
    sourceReference: rowReference(envelope, rowNumber),
    rowNumber,
  });
}

export function readLoadFeed(envelope: FeedEnvelope, rows: readonly Row[]): FeedRead<LoadDraft> {
  return readRows(envelope, rows, readLoadRow);
}

export function deliveredDrafts(read: FeedRead<LoadDraft>): LoadDraft[] {
  return read.accepted.filter(
    (draft) => draft.status === 'delivered' && draft.deliveredOn !== undefined,
  );
}

export function marginMinorOf(draft: LoadDraft): number {
  return draft.lineHaulMinor - draft.carrierPayMinor;
}
