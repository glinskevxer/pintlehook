import { describe, expect, it } from 'vitest';
import * as pintlehook from '../src/index.js';

describe('the public surface', () => {
  it('names a version', () => {
    expect(pintlehook.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exports the primitives a caller needs to build a value', () => {
    expect(typeof pintlehook.money).toBe('function');
    expect(typeof pintlehook.day).toBe('function');
    expect(typeof pintlehook.interval).toBe('function');
    expect(pintlehook.formatMoney(pintlehook.money('USD', 12_345))).toBe('123.45 USD');
  });

  it('exports the result helpers so a caller can read a failure', () => {
    expect(pintlehook.isOk(pintlehook.ok(1))).toBe(true);
    expect(pintlehook.isErr(pintlehook.fail('code', 'message'))).toBe(true);
    expect(pintlehook.unwrap(pintlehook.ok(41))).toBe(41);
  });

  it('exports every rule the program decides with', () => {
    for (const name of [
      'resolveActivation',
      'resolveAttribution',
      'resolveQualification',
      'runLadder',
      'assessRetention',
      'assessClawback',
      'assessHold',
    ] as const) {
      expect(typeof pintlehook[name]).toBe('function');
    }
  });

  it('exports the store and the checks over it', () => {
    const store = pintlehook.Store.empty();
    expect(store.sequence).toBe(0);
    expect(pintlehook.runIntegrity(store).clean).toBe(true);
    expect(pintlehook.unwrap(pintlehook.JournalLog.empty().verify())).toBe(0);
  });

  it('exports the services that write', () => {
    for (const name of [
      'fileCarrier',
      'enrolAdvocate',
      'recordTouch',
      'attributeReferral',
      'qualifyReferral',
      'runAccruals',
      'cutBatch',
      'runCycle',
      'reconcileProgram',
    ] as const) {
      expect(typeof pintlehook[name]).toBe('function');
    }
  });

  it('exports the reports and the api', () => {
    expect(pintlehook.reportNames().length).toBeGreaterThan(4);
    expect(pintlehook.allRoutes.length).toBeGreaterThan(14);
    expect(typeof pintlehook.buildRouter).toBe('function');
  });

  it('builds a working context through the exported surface alone', () => {
    const store = pintlehook.Store.empty();
    const context = pintlehook.unwrap(
      pintlehook.contextFor(store, pintlehook.fixedClock(Date.UTC(2025, 0, 1)), 'UTC', 'embedder'),
    );
    expect(context.clock.today()).toEqual(pintlehook.day(2025, 1, 1));
  });

  it('does not export anything from the command line', () => {
    const names = Object.keys(pintlehook);
    for (const leaked of ['buildProgram', 'openSession', 'consoleSink', 'main']) {
      expect(names).not.toContain(leaked);
    }
  });
});
