/**
 * A program is the referral scheme itself, and its rules change while carriers
 * are part way through qualifying. So a program is a run of versions, each
 * effective from a day, and every rule lookup goes through a day rather than
 * through the program.
 *
 * Which version applies is decided by the effective activation date of the
 * invited carrier, not by the day the work is being run. That is what makes a
 * change to the cure period able to move a bounty rate.
 */

import { compareDays, isBefore, type Day } from '../util/clock.js';
import { ascending, byKey, chain, sorted } from '../util/ordering.js';
import type { Currency } from '../util/money.js';
import { fail, ok, type Result } from '../util/result.js';
import type { ProgramId } from './identity.js';

export interface ProgramRules {
  /** Days before effective activation in which a touch can win attribution. */
  readonly attributionWindowDays: number;
  /** Days a conditionally approved packet has to get its certificate in. */
  readonly cureWindowDays: number;
  /** Delivered loads the invitee must complete for the referral to qualify. */
  readonly qualifyingLoadCount: number;
  /** Days from effective activation in which those loads must be delivered. */
  readonly qualifyingWindowDays: number;
  /** Days the invitee must keep hauling before a bounty stops being at risk. */
  readonly retentionDays: number;
  /** Ceiling on what one advocate can earn in a program year, in minor units. */
  readonly programYearCapMinor: number;
  /** Recovery balance above which a settlement batch is held, in minor units. */
  readonly releaseCeilingMinor: number;
  readonly currency: Currency;
}

export interface ProgramVersion {
  readonly version: number;
  readonly effectiveFrom: Day;
  readonly rules: ProgramRules;
  readonly note: string;
}

export interface Program {
  readonly id: ProgramId;
  readonly name: string;
  readonly openedOn: Day;
  readonly closedOn?: Day;
  readonly versions: readonly ProgramVersion[];
}

export function orderedVersions(program: Program): ProgramVersion[] {
  return sorted(
    program.versions,
    chain(
      byKey((v: ProgramVersion) => v.effectiveFrom, compareDays),
      byKey((v: ProgramVersion) => v.version, ascending),
    ),
  );
}

/** The version in force on a day. Nothing before the first effective day. */
export function versionOn(program: Program, when: Day): Result<ProgramVersion> {
  const ordered = orderedVersions(program);
  let found: ProgramVersion | undefined;
  for (const version of ordered) {
    if (!isBefore(when, version.effectiveFrom)) {
      found = version;
    }
  }
  if (found === undefined) {
    return fail(
      'program_no_version',
      `program ${program.id} had no version in force on the day asked about`,
    );
  }
  return ok(found);
}

export function rulesOn(program: Program, when: Day): Result<ProgramRules> {
  const version = versionOn(program, when);
  return version.ok ? ok(version.value.rules) : version;
}

export function isOpenOn(program: Program, when: Day): boolean {
  if (isBefore(when, program.openedOn)) {
    return false;
  }
  return program.closedOn === undefined || isBefore(when, program.closedOn);
}

export function validateProgram(program: Program): Result<Program> {
  if (program.versions.length === 0) {
    return fail('program_no_versions', 'a program needs at least one version');
  }
  if (program.closedOn !== undefined && !isBefore(program.openedOn, program.closedOn)) {
    return fail('program_closed_before_open', 'a program cannot close before it opens');
  }
  const ordered = orderedVersions(program);
  const numbers = new Set<number>();
  let previous: Day | undefined;
  for (const version of ordered) {
    if (numbers.has(version.version)) {
      return fail('program_version_repeated', `version ${version.version} appears twice`);
    }
    numbers.add(version.version);
    if (isBefore(version.effectiveFrom, program.openedOn)) {
      return fail(
        'program_version_before_open',
        `version ${version.version} takes effect before the program opened`,
      );
    }
    if (previous !== undefined && compareDays(previous, version.effectiveFrom) === 0) {
      return fail('program_versions_same_day', 'two versions cannot take effect on the same day');
    }
    previous = version.effectiveFrom;
    const problems = validateRules(version.rules);
    if (!problems.ok) {
      return problems;
    }
  }
  return ok(program);
}

export function validateRules(rules: ProgramRules): Result<ProgramRules> {
  const positive: [keyof ProgramRules, number][] = [
    ['attributionWindowDays', rules.attributionWindowDays],
    ['cureWindowDays', rules.cureWindowDays],
    ['qualifyingLoadCount', rules.qualifyingLoadCount],
    ['qualifyingWindowDays', rules.qualifyingWindowDays],
    ['retentionDays', rules.retentionDays],
  ];
  for (const [name, value] of positive) {
    if (!Number.isInteger(value) || value <= 0) {
      return fail('program_rule_not_positive', `${String(name)} must be a positive whole number`);
    }
  }
  if (rules.programYearCapMinor < 0 || rules.releaseCeilingMinor < 0) {
    return fail('program_rule_negative', 'a cap or ceiling cannot be negative');
  }
  return ok(rules);
}
