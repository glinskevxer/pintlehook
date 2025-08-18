/**
 * Reading the program catalogue off disk.
 *
 * The catalogue is a json file a person edits with a contract in front of them,
 * and it is validated the same way the api validates it, so a file that would
 * not load through the api cannot be loaded by putting it on disk instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseDay } from '../util/clock.js';
import { err, problem, type Result } from '../util/result.js';
import { readProgramId } from '../domain/identity.js';
import type { Program, ProgramVersion } from '../domain/program.js';
import type { RewardSchedule } from '../domain/schedule.js';
import { buildCatalog, type Catalog, type ScheduleBinding } from '../service/catalog.js';

const tierSchema = z.object({
  name: z.string().min(1),
  fromCount: z.number().int().positive(),
  flatMinor: z.number().int(),
  marginShare: z.number().int(),
});

const versionSchema = z.object({
  version: z.number().int().positive(),
  effectiveFrom: z.string(),
  note: z.string(),
  rules: z.object({
    attributionWindowDays: z.number().int(),
    cureWindowDays: z.number().int(),
    qualifyingLoadCount: z.number().int(),
    qualifyingWindowDays: z.number().int(),
    retentionDays: z.number().int(),
    programYearCapMinor: z.number().int(),
    releaseCeilingMinor: z.number().int(),
    currency: z.enum(['USD', 'CAD', 'MXN']),
  }),
  schedule: z.object({
    currency: z.enum(['USD', 'CAD', 'MXN']),
    tiers: z.array(tierSchema).min(1),
  }),
});

const fileSchema = z.object({
  programs: z.array(
    z.object({
      id: z.string(),
      name: z.string().min(1),
      openedOn: z.string(),
      closedOn: z.string().optional(),
      versions: z.array(versionSchema).min(1),
    }),
  ),
});

export function readCatalogText(text: string): Result<Catalog> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err([problem('catalog_file_unparseable', 'the catalogue file is not json')]);
  }
  const shaped = fileSchema.safeParse(parsed);
  if (!shaped.success) {
    return err(
      shaped.error.issues.map((issue) =>
        problem('catalog_file_shape', issue.message, issue.path.join('.') || undefined),
      ),
    );
  }
  const programs: Program[] = [];
  const bindings: ScheduleBinding[] = [];
  for (const entry of shaped.data.programs) {
    const id = readProgramId(entry.id);
    if (!id.ok) {
      return id;
    }
    const openedOn = parseDay(entry.openedOn);
    if (!openedOn.ok) {
      return openedOn;
    }
    const versions: ProgramVersion[] = [];
    for (const version of entry.versions) {
      const effectiveFrom = parseDay(version.effectiveFrom);
      if (!effectiveFrom.ok) {
        return effectiveFrom;
      }
      versions.push({
        version: version.version,
        effectiveFrom: effectiveFrom.value,
        rules: version.rules,
        note: version.note,
      });
      const schedule: RewardSchedule = version.schedule;
      bindings.push({ program: id.value, version: version.version, schedule });
    }
    const closedOn = entry.closedOn === undefined ? undefined : parseDay(entry.closedOn);
    if (closedOn !== undefined && !closedOn.ok) {
      return closedOn;
    }
    programs.push({
      id: id.value,
      name: entry.name,
      openedOn: openedOn.value,
      closedOn: closedOn === undefined ? undefined : closedOn.value,
      versions,
    });
  }
  return buildCatalog(programs, bindings);
}

export function readCatalogFile(path: string): Result<Catalog> {
  if (!existsSync(path)) {
    return err([problem('catalog_file_missing', `there is no catalogue at ${path}`)]);
  }
  return readCatalogText(readFileSync(path, 'utf8'));
}

export function emptyCatalog(): Result<Catalog> {
  return buildCatalog([], []);
}

export function catalogOrEmpty(path: string | undefined): Result<Catalog> {
  return path === undefined ? emptyCatalog() : readCatalogFile(path);
}

export function catalogSummary(catalog: Catalog): string {
  return `${catalog.programs.length} programs, ${catalog.bindings.length} schedules`;
}

export function programIds(catalog: Catalog): string[] {
  return catalog.programs.map((program) => program.id).sort();
}
