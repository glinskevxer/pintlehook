/**
 * Reads over the store. The tables are public because the fold has to write
 * them, but nothing above this layer should be reaching into an index by name,
 * so the questions the services actually ask live here with names.
 */

import { compareDays, type Day } from '../util/clock.js';
import { contains, type DayInterval } from '../util/interval.js';
import { ascending, byKey, byText, chain, sorted, type Comparator } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import {
  NO_DAY,
  isEnrolledRow,
  isOpenFlag,
  readDayText,
  type AccrualRow,
  type AdvocateRow,
  type CarrierRow,
  type ClaimRow,
  type FlagRow,
  type LoadRow,
  type ReferralRow,
  type TouchRow,
} from './rows.js';
import { referralKeyOf, type Store } from './store.js';
import type { Table } from './table.js';

/**
 * Every list read was written as "ask the index, then sort, and give nothing
 * back if the index name was wrong". Eleven copies of that meant eleven places
 * where a typo in an index name turned into an empty list rather than an error.
 */
function listBy<T>(table: Table<T>, index: string, key: string, compare: Comparator<T>): T[] {
  const rows = table.by(index, key);
  if (!rows.ok) {
    throw new Error(`${index} is not an index on this table`);
  }
  return sorted(rows.value, compare);
}

export function carrierById(store: Store, id: string): Result<CarrierRow> {
  const row = store.carriers.get(id);
  return row === undefined ? fail('carrier_unknown', `no carrier ${id}`) : ok(row);
}

export function carrierByMotorCarrierNumber(store: Store, mc: string): Result<CarrierRow> {
  const row = store.carriers.oneBy('mc', mc);
  if (!row.ok) {
    return row;
  }
  return row.value === undefined ? fail('carrier_unknown', `no carrier on ${mc}`) : ok(row.value);
}

export function advocateById(store: Store, id: string): Result<AdvocateRow> {
  const row = store.advocates.get(id);
  return row === undefined ? fail('advocate_unknown', `no advocate ${id}`) : ok(row);
}

export function advocateByCode(store: Store, code: string): Result<AdvocateRow> {
  const row = store.advocates.oneBy('code', code);
  if (!row.ok) {
    return row;
  }
  return row.value === undefined
    ? fail('advocate_code_unknown', `no advocate holds code ${code}`)
    : ok(row.value);
}

export function advocatesOfCarrier(store: Store, carrier: string): AdvocateRow[] {
  return listBy(
    store.advocates,
    'carrier',
    carrier,
    byKey((row: AdvocateRow) => row.id, byText),
  );
}

export function enrolledAdvocates(store: Store, program: string): AdvocateRow[] {
  return listBy(
    store.advocates,
    'program',
    program,
    byKey((row: AdvocateRow) => row.id, byText),
  ).filter(isEnrolledRow);
}

export function touchesForInvitee(store: Store, invitee: string): TouchRow[] {
  return listBy(
    store.touches,
    'invitee',
    invitee,
    chain(
      byKey((row: TouchRow) => row.at, ascending),
      byKey((row: TouchRow) => row.id, byText),
    ),
  );
}

export function touchesForAdvocate(store: Store, advocate: string): TouchRow[] {
  return listBy(
    store.touches,
    'advocate',
    advocate,
    byKey((row: TouchRow) => row.at, ascending),
  );
}

export function referralByKey(store: Store, program: string, invitee: string): Result<ReferralRow> {
  const key = referralKeyOf(program, invitee);
  const row = store.referrals.get(key);
  return row === undefined ? fail('referral_unknown', `no referral ${key}`) : ok(row);
}

export function referralsOfAdvocate(store: Store, advocate: string): ReferralRow[] {
  return listBy(
    store.referrals,
    'advocate',
    advocate,
    byKey((row: ReferralRow) => row.key, byText),
  );
}

export function referralsInState(store: Store, state: string): ReferralRow[] {
  return listBy(
    store.referrals,
    'state',
    state,
    byKey((row: ReferralRow) => row.key, byText),
  );
}

export function loadsOfCarrier(store: Store, carrier: string): LoadRow[] {
  return listBy(
    store.loads,
    'carrier',
    carrier,
    chain(
      byKey((row: LoadRow) => row.deliveredOn, byText),
      byKey((row: LoadRow) => row.proNumber, byText),
    ),
  );
}

export function deliveredLoadsIn(
  store: Store,
  carrier: string,
  window: DayInterval,
): Result<LoadRow[]> {
  const kept: LoadRow[] = [];
  for (const row of loadsOfCarrier(store, carrier)) {
    if (row.status !== 'delivered' || row.deliveredOn === NO_DAY) {
      continue;
    }
    const on = readDayText(row.deliveredOn, 'deliveredOn');
    if (!on.ok) {
      return on;
    }
    if (on.value !== undefined && contains(window, on.value)) {
      kept.push(row);
    }
  }
  return ok(kept);
}

export function claimsForLoad(store: Store, load: string): ClaimRow[] {
  return listBy(
    store.claims,
    'load',
    load,
    byKey((row: ClaimRow) => row.id, byText),
  );
}

export function claimsForCarrier(store: Store, carrier: string): ClaimRow[] {
  const loads = new Set(loadsOfCarrier(store, carrier).map((row) => row.id));
  return sorted(
    store.claims.where((row) => loads.has(row.load)),
    byKey((row: ClaimRow) => row.id, byText),
  );
}

export function accrualsOfAdvocate(store: Store, advocate: string): AccrualRow[] {
  return listBy(
    store.accruals,
    'advocate',
    advocate,
    chain(
      byKey((row: AccrualRow) => row.postedOn, byText),
      byKey((row: AccrualRow) => row.id, byText),
    ),
  );
}

export function accrualsForReferral(store: Store, referralKey: string): AccrualRow[] {
  return listBy(
    store.accruals,
    'referral',
    referralKey,
    byKey((row: AccrualRow) => row.id, byText),
  );
}

export function accrualsInProgramYear(
  store: Store,
  advocate: string,
  programYearFrom: string,
): AccrualRow[] {
  return listBy(
    store.accruals,
    'year',
    `${advocate}:${programYearFrom}`,
    byKey((row: AccrualRow) => row.id, byText),
  );
}

export function accrualsUpTo(store: Store, advocate: string, when: Day): Result<AccrualRow[]> {
  const kept: AccrualRow[] = [];
  for (const row of accrualsOfAdvocate(store, advocate)) {
    const on = readDayText(row.postedOn, 'postedOn');
    if (!on.ok) {
      return on;
    }
    if (on.value !== undefined && compareDays(on.value, when) <= 0) {
      kept.push(row);
    }
  }
  return ok(kept);
}

export function openFlagsOf(store: Store, advocate: string): string[] {
  return listBy(
    store.flags,
    'advocate',
    advocate,
    byKey((row: FlagRow) => row.flag, byText),
  )
    .filter(isOpenFlag)
    .map((row) => row.flag);
}

export function hasOpenFlags(store: Store, advocate: string): boolean {
  return openFlagsOf(store, advocate).length > 0;
}
