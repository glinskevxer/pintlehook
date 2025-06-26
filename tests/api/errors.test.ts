import { describe, expect, it } from 'vitest';
import { describeError, errorFrom, isClientError, statusFor } from '../../src/api/errors.js';
import { problem } from '../../src/util/result.js';

describe('statusFor', () => {
  it('reads a missing thing as not found', () => {
    expect(statusFor('carrier_unknown')).toBe(404);
    expect(statusFor('advocate_code_unknown')).toBe(404);
    expect(statusFor('registry_source_not_registered')).toBe(404);
    expect(statusFor('resolution_no_match')).toBe(404);
  });

  it('reads a state clash as a conflict', () => {
    expect(statusFor('enrolment_already_open')).toBe(409);
    expect(statusFor('batch_bad_transition')).toBe(409);
    expect(statusFor('catalog_program_repeated')).toBe(409);
    expect(statusFor('snapshot_journal_diverged')).toBe(409);
  });

  it('reads a rule that will not let something happen as unprocessable', () => {
    expect(statusFor('hold_not_liftable')).toBe(422);
    expect(statusFor('qualification_not_met')).toBe(422);
    expect(statusFor('attribution_uncredited')).toBe(422);
    expect(statusFor('report_advocate_required')).toBe(422);
    expect(statusFor('settlement_cut_too_early')).toBe(422);
  });

  it('reads anything else as a bad request', () => {
    expect(statusFor('field_not_boolean')).toBe(400);
    expect(statusFor('money_unparseable')).toBe(400);
  });

  it('reads an internal code as a server error', () => {
    expect(statusFor('internal_broke')).toBe(500);
  });

  it('does not need a table entry for a code it has never seen', () => {
    expect(statusFor('some_new_rule_unknown')).toBe(404);
    expect(statusFor('some_new_rule_went_sideways')).toBe(400);
  });
});

describe('errorFrom', () => {
  it('takes the status from the first problem', () => {
    const error = errorFrom([problem('carrier_unknown', 'no carrier cxr_9')]);
    expect(error.status).toBe(404);
    expect(error.code).toBe('carrier_unknown');
  });

  it('keeps every problem for the caller to read', () => {
    const error = errorFrom([problem('a', 'first'), problem('b', 'second')]);
    expect(error.problems).toHaveLength(2);
  });

  it('carries the path when there is one', () => {
    expect(errorFrom([problem('field_missing', 'no code', 'referral_code')]).path).toBe(
      'referral_code',
    );
  });

  it('leaves the path off when there is not', () => {
    expect(errorFrom([problem('field_missing', 'no code')]).path).toBeUndefined();
  });

  it('turns an empty failure into a server error rather than pretending', () => {
    const error = errorFrom([]);
    expect(error.status).toBe(500);
    expect(error.code).toBe('internal_no_problem');
  });
});

describe('isClientError', () => {
  it('is true for the four hundreds', () => {
    expect(isClientError(errorFrom([problem('carrier_unknown', 'x')]))).toBe(true);
    expect(isClientError(errorFrom([problem('field_missing', 'x')]))).toBe(true);
  });

  it('is false for a server error', () => {
    expect(isClientError(errorFrom([]))).toBe(false);
  });
});

describe('describeError', () => {
  it('reads the way a log line reads', () => {
    const error = errorFrom([problem('carrier_unknown', 'no carrier cxr_9')]);
    expect(describeError(error)).toBe('404 carrier_unknown: no carrier cxr_9');
  });

  it('names the field when there is one', () => {
    const error = errorFrom([problem('field_missing', 'no code', 'referral_code')]);
    expect(describeError(error)).toContain('at referral_code');
  });
});
