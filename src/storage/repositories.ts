/**
 * Reads over the store. The tables are public because the fold has to write
 * them, but nothing above this layer should be reaching into an index by name,
 * so the questions the services actually ask live here with names.
 */

import { compareDays, type Day } from '../util/clock.js';
import { contains, type DayInterval } from '../util/interval.js';
import { ascending, byKey, byText, chain, sorted } from '../util/ordering.js';
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
  type LoadRow,
  type ReferralRow,
  type TouchRow,
} from './rows.js';
import { referralKeyOf, type Store } from './store.js';

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
  const rows = store.advocates.by('carrier', carrier);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: AdvocateRow) => row.id, byText),
      )
    : [];
}

export function enrolledAdvocates(store: Store, program: string): AdvocateRow[] {
  const rows = store.advocates.by('program', program);
  return rows.ok
    ? sorted(
        rows.value.filter(isEnrolledRow),
        byKey((row: AdvocateRow) => row.id, byText),
      )
    : [];
}

export function touchesForInvitee(store: Store, invitee: string): TouchRow[] {
  const rows = store.touches.by('invitee', invitee);
  return rows.ok
    ? sorted(
        rows.value,
        chain(
          byKey((row: TouchRow) => row.at, ascending),
          byKey((row: TouchRow) => row.id, byText),
        ),
      )
    : [];
}

export function touchesForAdvocate(store: Store, advocate: string): TouchRow[] {
  const rows = store.touches.by('advocate', advocate);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: TouchRow) => row.at, ascending),
      )
    : [];
}

export function referralByKey(store: Store, program: string, invitee: string): Result<ReferralRow> {
  const key = referralKeyOf(program, invitee);
  const row = store.referrals.get(key);
  return row === undefined ? fail('referral_unknown', `no referral ${key}`) : ok(row);
}

export function referralsOfAdvocate(store: Store, advocate: string): ReferralRow[] {
  const rows = store.referrals.by('advocate', advocate);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: ReferralRow) => row.key, byText),
      )
    : [];
}

export function referralsInState(store: Store, state: string): ReferralRow[] {
  const rows = store.referrals.by('state', state);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: ReferralRow) => row.key, byText),
      )
    : [];
}

export function loadsOfCarrier(store: Store, carrier: string): LoadRow[] {
  const rows = store.loads.by('carrier', carrier);
  return rows.ok
    ? sorted(
        rows.value,
        chain(
          byKey((row: LoadRow) => row.deliveredOn, byText),
          byKey((row: LoadRow) => row.proNumber, byText),
        ),
      )
    : [];
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
  const rows = store.claims.by('load', load);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: ClaimRow) => row.id, byText),
      )
    : [];
}

export function claimsForCarrier(store: Store, carrier: string): ClaimRow[] {
  const loads = new Set(loadsOfCarrier(store, carrier).map((row) => row.id));
  return sorted(
    store.claims.where((row) => loads.has(row.load)),
    byKey((row: ClaimRow) => row.id, byText),
  );
}

export function accrualsOfAdvocate(store: Store, advocate: string): AccrualRow[] {
  const rows = store.accruals.by('advocate', advocate);
  return rows.ok
    ? sorted(
        rows.value,
        chain(
          byKey((row: AccrualRow) => row.postedOn, byText),
          byKey((row: AccrualRow) => row.id, byText),
        ),
      )
    : [];
}

export function accrualsForReferral(store: Store, referralKey: string): AccrualRow[] {
  const rows = store.accruals.by('referral', referralKey);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: AccrualRow) => row.id, byText),
      )
    : [];
}

export function accrualsInProgramYear(
  store: Store,
  advocate: string,
  programYearFrom: string,
): AccrualRow[] {
  const rows = store.accruals.by('year', `${advocate}:${programYearFrom}`);
  return rows.ok
    ? sorted(
        rows.value,
        byKey((row: AccrualRow) => row.id, byText),
      )
    : [];
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
  const rows = store.flags.by('advocate', advocate);
  return rows.ok
    ? sorted(
        rows.value.filter(isOpenFlag).map((row) => row.flag),
        byText,
      )
    : [];
}

export function hasOpenFlags(store: Store, advocate: string): boolean {
  return openFlagsOf(store, advocate).length > 0;
}
