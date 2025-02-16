/**
 * Integrity checks over the folded tables. The journal defends itself with its
 * digest chain, but a chain of well formed records can still fold into a state
 * nobody would defend, and this is where that gets caught.
 *
 * Every check is stated as a question with a yes or no answer and a list of the
 * rows that answered wrong, because a check that only reports a count leaves the
 * reader nowhere to go.
 */

import { byText, sorted } from '../util/ordering.js';
import { NO_DAY, isOpenFlag, readDayText } from './rows.js';
import type { Store } from './store.js';

export interface IntegrityFinding {
  readonly check: string;
  readonly subject: string;
  readonly detail: string;
}

export interface IntegrityReport {
  readonly clean: boolean;
  readonly findings: readonly IntegrityFinding[];
  readonly checksRun: number;
}

function finding(check: string, subject: string, detail: string): IntegrityFinding {
  return { check, subject, detail };
}

export function checkAdvocateCarriers(store: Store): IntegrityFinding[] {
  return store.advocates
    .where((row) => !store.carriers.has(row.carrier))
    .map((row) =>
      finding('advocate_carrier_exists', row.id, `carrier ${row.carrier} is not filed`),
    );
}

export function checkReferralAdvocates(store: Store): IntegrityFinding[] {
  return store.referrals
    .where((row) => row.advocate !== '' && !store.advocates.has(row.advocate))
    .map((row) =>
      finding('referral_advocate_exists', row.key, `advocate ${row.advocate} is not enrolled`),
    );
}

export function checkQualifiedHaveAdvocates(store: Store): IntegrityFinding[] {
  return store.referrals
    .where((row) => row.state === 'qualified' && row.advocate === '')
    .map((row) =>
      finding('qualified_has_advocate', row.key, 'a qualified referral has no advocate'),
    );
}

export function checkQualifiedHaveDates(store: Store): IntegrityFinding[] {
  return store.referrals
    .where((row) => row.state === 'qualified' && row.qualifiedOn === NO_DAY)
    .map((row) => finding('qualified_has_date', row.key, 'a qualified referral has no date'));
}

export function checkAccrualReferrals(store: Store): IntegrityFinding[] {
  return store.accruals
    .where((row) => !store.referrals.has(row.referralKey))
    .map((row) =>
      finding('accrual_referral_exists', row.id, `referral ${row.referralKey} is not open`),
    );
}

export function checkAccrualAdvocates(store: Store): IntegrityFinding[] {
  return store.accruals
    .where((row) => !store.advocates.has(row.advocate))
    .map((row) =>
      finding('accrual_advocate_exists', row.id, `advocate ${row.advocate} is unknown`),
    );
}

export function checkReversalsPointSomewhere(store: Store): IntegrityFinding[] {
  return store.accruals
    .where((row) => row.kind === 'reversal' && !store.accruals.has(row.reverses))
    .map((row) =>
      finding(
        'reversal_points_somewhere',
        row.id,
        `it reverses ${row.reverses}, which is not here`,
      ),
    );
}

export function checkClaimLoads(store: Store): IntegrityFinding[] {
  return store.claims
    .where((row) => !store.loads.has(row.load))
    .map((row) => finding('claim_load_exists', row.id, `load ${row.load} is unknown`));
}

export function checkCurrencies(store: Store): IntegrityFinding[] {
  const currencies = new Set(store.accruals.all().map((row) => row.currency));
  if (currencies.size <= 1) {
    return [];
  }
  return [
    finding(
      'one_currency_per_program',
      'accruals',
      `the accrual table holds ${[...currencies].sort().join(', ')}`,
    ),
  ];
}

export function checkDayFields(store: Store): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const row of store.accruals.all()) {
    const posted = readDayText(row.postedOn, 'postedOn');
    if (!posted.ok || posted.value === undefined) {
      findings.push(finding('accrual_day_readable', row.id, `postedOn reads "${row.postedOn}"`));
    }
  }
  for (const row of store.referrals.all()) {
    const recorded = readDayText(row.recordedOn, 'recordedOn');
    if (!recorded.ok || recorded.value === undefined) {
      findings.push(
        finding('referral_day_readable', row.key, `recordedOn reads "${row.recordedOn}"`),
      );
    }
  }
  return findings;
}

export function checkFlagsHaveAdvocates(store: Store): IntegrityFinding[] {
  return store.flags
    .where((row) => isOpenFlag(row) && !store.advocates.has(row.advocate))
    .map((row) => finding('flag_advocate_exists', row.key, `advocate ${row.advocate} is unknown`));
}

const CHECKS = [
  checkAdvocateCarriers,
  checkReferralAdvocates,
  checkQualifiedHaveAdvocates,
  checkQualifiedHaveDates,
  checkAccrualReferrals,
  checkAccrualAdvocates,
  checkReversalsPointSomewhere,
  checkClaimLoads,
  checkCurrencies,
  checkDayFields,
  checkFlagsHaveAdvocates,
] as const;

export function runIntegrity(store: Store): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  for (const check of CHECKS) {
    findings.push(...check(store));
  }
  const ordered = sorted(findings, (left, right) => {
    const byCheck = byText(left.check, right.check);
    return byCheck !== 0 ? byCheck : byText(left.subject, right.subject);
  });
  return { clean: ordered.length === 0, findings: ordered, checksRun: CHECKS.length };
}

export function describeReport(report: IntegrityReport): string {
  return report.clean
    ? `${report.checksRun} checks, nothing found`
    : `${report.checksRun} checks, ${report.findings.length} findings`;
}
