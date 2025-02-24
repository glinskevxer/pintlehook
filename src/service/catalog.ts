/**
 * The program catalogue. Programs, their versions and their reward schedules
 * are configuration rather than events, because they are written by a person
 * with a contract in front of them and reviewed before they take effect.
 *
 * What the catalogue enforces is the join: a version names a schedule, and a
 * schedule that no version names is a schedule somebody edited and forgot to
 * wire up. That has happened, and it cost a settlement run.
 */

import type { Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import {
  rulesOn,
  validateProgram,
  versionOn,
  type Program,
  type ProgramRules,
  type ProgramVersion,
} from '../domain/program.js';
import { validateSchedule, type RewardSchedule } from '../domain/schedule.js';
import type { ProgramId } from '../domain/identity.js';

export interface ScheduleBinding {
  readonly program: ProgramId;
  readonly version: number;
  readonly schedule: RewardSchedule;
}

export interface Catalog {
  readonly programs: readonly Program[];
  readonly bindings: readonly ScheduleBinding[];
}

function bindingKey(program: ProgramId, version: number): string {
  return `${program}#${version}`;
}

export function buildCatalog(
  programs: readonly Program[],
  bindings: readonly ScheduleBinding[],
): Result<Catalog> {
  const seenPrograms = new Set<string>();
  for (const program of programs) {
    if (seenPrograms.has(program.id)) {
      return fail('catalog_program_repeated', `program ${program.id} appears twice`);
    }
    seenPrograms.add(program.id);
    const checked = validateProgram(program);
    if (!checked.ok) {
      return checked;
    }
  }
  const seenBindings = new Set<string>();
  for (const binding of bindings) {
    const key = bindingKey(binding.program, binding.version);
    if (seenBindings.has(key)) {
      return fail('catalog_binding_repeated', `${key} is bound twice`);
    }
    seenBindings.add(key);
    const checked = validateSchedule(binding.schedule);
    if (!checked.ok) {
      return checked;
    }
    const program = programs.find((candidate) => candidate.id === binding.program);
    if (program === undefined) {
      return fail('catalog_binding_orphan', `${key} names a program that is not here`);
    }
    if (!program.versions.some((version) => version.version === binding.version)) {
      return fail('catalog_binding_orphan', `${key} names a version that is not here`);
    }
  }
  for (const program of programs) {
    for (const version of program.versions) {
      if (!seenBindings.has(bindingKey(program.id, version.version))) {
        return fail(
          'catalog_version_unbound',
          `${program.id} version ${version.version} has no reward schedule`,
        );
      }
    }
  }
  return ok({ programs, bindings });
}

export function programById(catalog: Catalog, id: ProgramId): Result<Program> {
  const program = catalog.programs.find((candidate) => candidate.id === id);
  return program === undefined ? fail('catalog_program_unknown', `no program ${id}`) : ok(program);
}

export function versionFor(catalog: Catalog, id: ProgramId, when: Day): Result<ProgramVersion> {
  const program = programById(catalog, id);
  return program.ok ? versionOn(program.value, when) : program;
}

export function rulesFor(catalog: Catalog, id: ProgramId, when: Day): Result<ProgramRules> {
  const program = programById(catalog, id);
  return program.ok ? rulesOn(program.value, when) : program;
}

export function scheduleFor(catalog: Catalog, id: ProgramId, when: Day): Result<RewardSchedule> {
  const version = versionFor(catalog, id, when);
  if (!version.ok) {
    return version;
  }
  const binding = catalog.bindings.find(
    (candidate) => candidate.program === id && candidate.version === version.value.version,
  );
  return binding === undefined
    ? fail('catalog_schedule_missing', `no schedule for ${id} version ${version.value.version}`)
    : ok(binding.schedule);
}

export function openPrograms(catalog: Catalog, when: Day): Program[] {
  return catalog.programs.filter((program) => {
    const version = versionOn(program, when);
    return version.ok;
  });
}

export function describeCatalog(catalog: Catalog): string {
  return `${catalog.programs.length} programs, ${catalog.bindings.length} schedules`;
}
