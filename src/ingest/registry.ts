/**
 * The source registry. Every partner that ships us a file has settings, and
 * they differ enough that hard coding any of them has bitten us: the fuel desk
 * runs in one zone with a drifting terminal, the claims administrator ships in
 * UTC and reships constantly, and recruiting ships once a week from a laptop.
 */

import { fail, ok, type Result } from '../util/result.js';
import { isZoneId, type ZoneId } from '../util/zoned.js';
import type { FeedKind } from './envelope.js';

export interface SourceSettings {
  readonly source: string;
  readonly kind: FeedKind;
  readonly zone: ZoneId;
  /** Milliseconds inside which two events from this source are one event. */
  readonly toleranceMillis: number;
  readonly acceptReplays: boolean;
  /** Reject the whole delivery when this share of rows fails, one to a hundred. */
  readonly rejectionCeilingPercent: number;
  readonly enabled: boolean;
}

export interface Registry {
  readonly settings: readonly SourceSettings[];
}

export function registryKey(source: string, kind: FeedKind): string {
  return `${source}/${kind}`;
}

export function validateSettings(settings: SourceSettings): Result<SourceSettings> {
  if (settings.source.trim() === '') {
    return fail('registry_source_blank', 'a source needs a name');
  }
  const zone: string = settings.zone;
  if (!isZoneId(zone)) {
    return fail('registry_zone_unknown', `no rule table for zone "${zone}"`);
  }
  if (!Number.isInteger(settings.toleranceMillis) || settings.toleranceMillis < 0) {
    return fail(
      'registry_tolerance_invalid',
      'the tolerance must be a whole number of milliseconds',
    );
  }
  if (
    !Number.isInteger(settings.rejectionCeilingPercent) ||
    settings.rejectionCeilingPercent < 1 ||
    settings.rejectionCeilingPercent > 100
  ) {
    return fail('registry_ceiling_invalid', 'the rejection ceiling is a percentage from 1 to 100');
  }
  return ok(settings);
}

export function buildRegistry(settings: readonly SourceSettings[]): Result<Registry> {
  const seen = new Set<string>();
  for (const entry of settings) {
    const checked = validateSettings(entry);
    if (!checked.ok) {
      return checked;
    }
    const key = registryKey(entry.source, entry.kind);
    if (seen.has(key)) {
      return fail('registry_source_repeated', `${key} is registered twice`);
    }
    seen.add(key);
  }
  return ok({ settings });
}

export function lookup(registry: Registry, source: string, kind: FeedKind): Result<SourceSettings> {
  const key = registryKey(source, kind);
  const found = registry.settings.find((entry) => registryKey(entry.source, entry.kind) === key);
  if (found === undefined) {
    return fail('registry_source_unknown', `${key} is not a registered source`);
  }
  if (!found.enabled) {
    return fail('registry_source_disabled', `${key} is registered but switched off`);
  }
  return ok(found);
}

export function enabledSources(registry: Registry): SourceSettings[] {
  return registry.settings.filter((entry) => entry.enabled);
}

export function sourcesForKind(registry: Registry, kind: FeedKind): SourceSettings[] {
  return enabledSources(registry).filter((entry) => entry.kind === kind);
}

/** Whether a delivery failed badly enough that the whole file should be refused. */
export function breachesCeiling(
  settings: SourceSettings,
  accepted: number,
  rejected: number,
): boolean {
  const total = accepted + rejected;
  if (total === 0) {
    return false;
  }
  return (rejected * 100) / total >= settings.rejectionCeilingPercent;
}

export function withSetting(
  registry: Registry,
  source: string,
  kind: FeedKind,
  change: Partial<SourceSettings>,
): Result<Registry> {
  const key = registryKey(source, kind);
  let found = false;
  const settings = registry.settings.map((entry) => {
    if (registryKey(entry.source, entry.kind) !== key) {
      return entry;
    }
    found = true;
    return { ...entry, ...change, source: entry.source, kind: entry.kind };
  });
  if (!found) {
    return fail('registry_source_unknown', `${key} is not a registered source`);
  }
  return buildRegistry(settings);
}
