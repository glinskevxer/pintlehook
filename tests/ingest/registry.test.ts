import { describe, expect, it } from 'vitest';
import {
  breachesCeiling,
  buildRegistry,
  enabledSources,
  lookup,
  registryKey,
  sourcesForKind,
  validateSettings,
  withSetting,
  type SourceSettings,
} from '../../src/ingest/registry.js';
import { isErr, unwrap } from '../../src/util/result.js';

function settings(overrides: Partial<SourceSettings> = {}): SourceSettings {
  return {
    source: 'fuel-desk',
    kind: 'touch',
    zone: 'America/Chicago',
    toleranceMillis: 30_000,
    acceptReplays: false,
    rejectionCeilingPercent: 20,
    enabled: true,
    ...overrides,
  };
}

const registry = unwrap(
  buildRegistry([
    settings(),
    settings({ source: 'recruiting', toleranceMillis: 120_000 }),
    settings({ source: 'claims-admin', kind: 'claim', zone: 'UTC', acceptReplays: true }),
    settings({ source: 'old-desk', enabled: false }),
  ]),
);

describe('registryKey', () => {
  it('joins the source and the kind', () => {
    expect(registryKey('fuel-desk', 'touch')).toBe('fuel-desk/touch');
  });

  it('lets one source ship two kinds', () => {
    expect(registryKey('a', 'touch')).not.toBe(registryKey('a', 'load'));
  });
});

describe('validateSettings', () => {
  it('accepts good settings', () => {
    expect(unwrap(validateSettings(settings())).source).toBe('fuel-desk');
  });

  it('refuses a blank source', () => {
    expect(isErr(validateSettings(settings({ source: '  ' })))).toBe(true);
  });

  it('refuses a zone we have no rule table for', () => {
    expect(isErr(validateSettings(settings({ zone: 'Europe/Riga' as never })))).toBe(true);
  });

  it('refuses a negative tolerance', () => {
    expect(isErr(validateSettings(settings({ toleranceMillis: -1 })))).toBe(true);
  });

  it('refuses a ceiling outside one to a hundred', () => {
    expect(isErr(validateSettings(settings({ rejectionCeilingPercent: 0 })))).toBe(true);
    expect(isErr(validateSettings(settings({ rejectionCeilingPercent: 101 })))).toBe(true);
    expect(isErr(validateSettings(settings({ rejectionCeilingPercent: 100 })))).toBe(false);
  });
});

describe('buildRegistry', () => {
  it('refuses the same source and kind twice', () => {
    const r = buildRegistry([settings(), settings()]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('registry_source_repeated');
    }
  });

  it('allows one source shipping two kinds', () => {
    expect(isErr(buildRegistry([settings(), settings({ kind: 'load' })]))).toBe(false);
  });

  it('passes a settings problem through', () => {
    expect(isErr(buildRegistry([settings({ toleranceMillis: -1 })]))).toBe(true);
  });

  it('accepts an empty registry', () => {
    expect(unwrap(buildRegistry([])).settings).toEqual([]);
  });
});

describe('lookup', () => {
  it('finds a registered source', () => {
    expect(unwrap(lookup(registry, 'recruiting', 'touch')).toleranceMillis).toBe(120_000);
  });

  it('refuses one that is not registered', () => {
    const r = lookup(registry, 'nobody', 'touch');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('registry_source_unknown');
    }
  });

  it('refuses one that is switched off', () => {
    const r = lookup(registry, 'old-desk', 'touch');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('registry_source_disabled');
    }
  });

  it('does not find a source under the wrong kind', () => {
    expect(isErr(lookup(registry, 'fuel-desk', 'load'))).toBe(true);
  });
});

describe('listing', () => {
  it('leaves the switched off sources out', () => {
    expect(enabledSources(registry)).toHaveLength(3);
  });

  it('filters by kind', () => {
    expect(sourcesForKind(registry, 'touch')).toHaveLength(2);
    expect(sourcesForKind(registry, 'claim')).toHaveLength(1);
    expect(sourcesForKind(registry, 'load')).toHaveLength(0);
  });
});

describe('breachesCeiling', () => {
  it('is false for an empty delivery', () => {
    expect(breachesCeiling(settings(), 0, 0)).toBe(false);
  });

  it('is false below the ceiling', () => {
    expect(breachesCeiling(settings(), 90, 10)).toBe(false);
  });

  it('is true at the ceiling', () => {
    expect(breachesCeiling(settings(), 80, 20)).toBe(true);
  });

  it('follows the source setting', () => {
    expect(breachesCeiling(settings({ rejectionCeilingPercent: 5 }), 90, 10)).toBe(true);
  });
});

describe('withSetting', () => {
  it('changes one source and leaves the rest', () => {
    const changed = unwrap(withSetting(registry, 'fuel-desk', 'touch', { toleranceMillis: 5_000 }));
    expect(unwrap(lookup(changed, 'fuel-desk', 'touch')).toleranceMillis).toBe(5_000);
    expect(unwrap(lookup(changed, 'recruiting', 'touch')).toleranceMillis).toBe(120_000);
  });

  it('will not let a change move a source to another key', () => {
    const changed = unwrap(
      withSetting(registry, 'fuel-desk', 'touch', { source: 'somewhere-else', kind: 'load' }),
    );
    expect(isErr(lookup(changed, 'somewhere-else', 'load'))).toBe(true);
    expect(isErr(lookup(changed, 'fuel-desk', 'touch'))).toBe(false);
  });

  it('refuses a source that is not registered', () => {
    expect(isErr(withSetting(registry, 'nobody', 'touch', { enabled: false }))).toBe(true);
  });

  it('validates the result', () => {
    expect(isErr(withSetting(registry, 'fuel-desk', 'touch', { toleranceMillis: -1 }))).toBe(true);
  });

  it('can switch a source back on', () => {
    const changed = unwrap(withSetting(registry, 'old-desk', 'touch', { enabled: true }));
    expect(isErr(lookup(changed, 'old-desk', 'touch'))).toBe(false);
  });
});
