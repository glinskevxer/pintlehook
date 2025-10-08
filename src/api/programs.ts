/**
 * Program and catalogue routes. Read only, because a program version is
 * configuration reviewed against a contract and nothing should be able to add
 * one over an api.
 *
 * The version endpoint takes a day rather than defaulting to today, so a caller
 * asking "which rules applied to this packet" gets the answer for the packet
 * rather than the answer for this morning.
 */

import { formatDay } from '../util/clock.js';
import { ok, type Result } from '../util/result.js';
import type { ProgramId } from '../domain/identity.js';
import { readProgramId } from '../domain/identity.js';
import { orderedTiers } from '../domain/schedule.js';
import { programById, rulesFor, scheduleFor, versionFor } from '../service/catalog.js';
import { pathValue, queryDayOrToday } from './parse.js';
import type { Route } from './router.js';

function programFrom(params: Readonly<Record<string, string>>): Result<ProgramId> {
  const raw = pathValue(params, 'program');
  return raw.ok ? readProgramId(raw.value) : raw;
}

export const listPrograms: Route = {
  method: 'get',
  path: '/programs',
  summary: 'every program in the catalogue with its version count',
  handle: (_context, catalog) =>
    ok(
      catalog.programs.map((program) => ({
        program: program.id,
        name: program.name,
        openedOn: formatDay(program.openedOn),
        closedOn: program.closedOn === undefined ? null : formatDay(program.closedOn),
        versions: program.versions.length,
      })),
    ),
};

export const getProgram: Route = {
  method: 'get',
  path: '/programs/:program',
  summary: 'one program with every version it has had',
  handle: (_context, catalog, _request, params) => {
    const program = programFrom(params);
    if (!program.ok) {
      return program;
    }
    const found = programById(catalog, program.value);
    if (!found.ok) {
      return found;
    }
    return ok({
      program: found.value.id,
      name: found.value.name,
      openedOn: formatDay(found.value.openedOn),
      versions: found.value.versions.map((version) => ({
        version: version.version,
        effectiveFrom: formatDay(version.effectiveFrom),
        note: version.note,
      })),
    });
  },
};

export const getRules: Route = {
  method: 'get',
  path: '/programs/:program/rules',
  summary: 'the rules in force on a day, which defaults to today',
  handle: (context, catalog, request, params) => {
    const program = programFrom(params);
    if (!program.ok) {
      return program;
    }
    const on = queryDayOrToday(context, request, 'on');
    if (!on.ok) {
      return on;
    }
    const version = versionFor(catalog, program.value, on.value);
    if (!version.ok) {
      return version;
    }
    const rules = rulesFor(catalog, program.value, on.value);
    if (!rules.ok) {
      return rules;
    }
    return ok({
      program: program.value,
      on: formatDay(on.value),
      version: version.value.version,
      rules: rules.value,
    });
  },
};

export const getSchedule: Route = {
  method: 'get',
  path: '/programs/:program/schedule',
  summary: 'the reward ladder in force on a day',
  handle: (context, catalog, request, params) => {
    const program = programFrom(params);
    if (!program.ok) {
      return program;
    }
    const on = queryDayOrToday(context, request, 'on');
    if (!on.ok) {
      return on;
    }
    const schedule = scheduleFor(catalog, program.value, on.value);
    if (!schedule.ok) {
      return schedule;
    }
    return ok({
      program: program.value,
      on: formatDay(on.value),
      currency: schedule.value.currency,
      tiers: orderedTiers(schedule.value),
    });
  },
};

export const programRoutes: readonly Route[] = [listPrograms, getProgram, getRules, getSchedule];
