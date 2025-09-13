import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DEPENDENCIES,
  BRANCH_FLOOR,
  STATEMENT_FLOOR,
  checkDependencies,
  checkEventFields,
  checkPinnedVersions,
  checkReportsReachable,
  checkRouteSummaries,
  checksWithoutCoverage,
  run,
} from '../../scripts/release-check.js';

describe('the dependency check', () => {
  it('passes on the two we meant to have', () => {
    const check = checkDependencies();
    expect(check.passed).toBe(true);
    for (const name of ALLOWED_DEPENDENCIES) {
      expect(check.detail).toContain(name);
    }
  });

  it('names exactly two allowed runtime dependencies', () => {
    expect(ALLOWED_DEPENDENCIES).toHaveLength(2);
  });
});

describe('the pinned version check', () => {
  it('passes, because every version in the manifest is exact', () => {
    const check = checkPinnedVersions();
    expect(check.passed).toBe(true);
    expect(check.detail).toContain('pinned');
  });
});

describe('the route summary check', () => {
  it('passes over the assembled api', () => {
    const check = checkRouteSummaries();
    expect(check.passed).toBe(true);
    expect(check.detail).toContain('routes');
  });
});

describe('the report reachability check', () => {
  it('passes, every definition answers to its own name', () => {
    expect(checkReportsReachable().passed).toBe(true);
  });
});

describe('the event field check', () => {
  it('passes, every event kind names what it needs', () => {
    const check = checkEventFields();
    expect(check.passed).toBe(true);
    expect(check.detail).toContain('event kinds');
  });
});

describe('the floors', () => {
  it('are set below what the suite reaches, with headroom', () => {
    expect(STATEMENT_FLOOR).toBeGreaterThan(85);
    expect(BRANCH_FLOOR).toBeGreaterThan(80);
    expect(STATEMENT_FLOOR).toBeLessThan(100);
  });
});

describe('running the gate', () => {
  it('runs every check and passes without the coverage one', () => {
    expect(checksWithoutCoverage().length).toBeGreaterThan(4);
    expect(run(false)).toBe(0);
  });

  it('reports each check by name', () => {
    for (const check of checksWithoutCoverage()) {
      expect(check.name.length).toBeGreaterThan(5);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });
});
