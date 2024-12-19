import { describe, expect, it } from 'vitest';
import type { DedupeCandidate } from '../../src/ingest/dedupe.js';
import {
  everyRowAccountedFor,
  problemsOf,
  runPipeline,
  summarize,
  type PipelineOptions,
} from '../../src/ingest/pipeline.js';
import { readTouchFeed, type TouchDraft } from '../../src/ingest/touchFeed.js';
import { day } from '../../src/util/clock.js';
import { mintReferralCode } from '../../src/util/ids.js';
import { isErr, unwrap } from '../../src/util/result.js';

const code = unwrap(mintReferralCode('AB3K9Z'));

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    source: 'fuel-desk',
    kind: 'touch',
    cutAt: '2025-04-01T06:00:00Z',
    declaredRows: 2,
    zone: 'America/Chicago',
    sequence: 118,
    ...overrides,
  };
}

function row(overrides: Record<string, string> = {}) {
  return {
    referral_code: code,
    channel: 'card',
    occurred_at: '2025-03-15T15:04:00Z',
    invitee_mc: 'MC884210',
    ...overrides,
  };
}

const candidate = (draft: TouchDraft): DedupeCandidate => ({
  naturalKey: `${draft.presentedCode}:${draft.at}:${draft.channel}`,
  collapseKey: `${draft.presentedCode}:${draft.inviteeMotorCarrierNumber ?? ''}`,
  at: draft.at,
  sourceReference: draft.sourceReference,
  strength: draft.channel === 'packet' ? 4 : 1,
});

function options(
  overrides: Partial<PipelineOptions<TouchDraft>> = {},
): PipelineOptions<TouchDraft> {
  return {
    readRows: readTouchFeed,
    candidate,
    toleranceMillis: 30_000,
    filedOn: day(2025, 4, 1),
    highestSequenceSeen: undefined,
    acceptReplays: false,
    ...overrides,
  };
}

describe('the happy path', () => {
  it('accepts two good rows', () => {
    const outcome = unwrap(
      runPipeline(envelope(), [row(), row({ occurred_at: '2025-03-16T15:04:00Z' })], options()),
    );
    expect(outcome.accepted).toHaveLength(2);
    expect(outcome.quarantined).toHaveLength(0);
    expect(outcome.duplicates).toBe(0);
    expect(outcome.replay).toBe(false);
  });

  it('accounts for every row the partner declared', () => {
    const outcome = unwrap(
      runPipeline(envelope(), [row(), row({ channel: 'billboard' })], options()),
    );
    expect(everyRowAccountedFor(outcome)).toBe(true);
  });
});

describe('stopping early', () => {
  it('stops on an envelope it cannot read', () => {
    const r = runPipeline(envelope({ zone: 'Europe/Riga' }), [row(), row()], options());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('envelope_zone_unknown');
    }
  });

  it('stops on a row count that does not match', () => {
    const r = runPipeline(envelope({ declaredRows: 5 }), [row(), row()], options());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('envelope_row_count');
    }
  });

  it('does not stop on a bad row', () => {
    const outcome = unwrap(
      runPipeline(envelope(), [row(), row({ channel: 'billboard' })], options()),
    );
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.quarantined).toHaveLength(1);
  });
});

describe('replays', () => {
  it('refuses a sequence already seen', () => {
    const r = runPipeline(
      envelope(),
      [row(), row({ occurred_at: '2025-03-16T15:04:00Z' })],
      options({ highestSequenceSeen: 118 }),
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('pipeline_replay_refused');
    }
  });

  it('accepts a replay when the caller asked for one', () => {
    const outcome = unwrap(
      runPipeline(
        envelope(),
        [row(), row({ occurred_at: '2025-03-16T15:04:00Z' })],
        options({ highestSequenceSeen: 118, acceptReplays: true }),
      ),
    );
    expect(outcome.replay).toBe(true);
    expect(outcome.accepted).toHaveLength(2);
  });

  it('accepts a sequence above the highest seen', () => {
    const outcome = unwrap(
      runPipeline(
        envelope({ sequence: 119 }),
        [row(), row({ occurred_at: '2025-03-16T15:04:00Z' })],
        options({ highestSequenceSeen: 118 }),
      ),
    );
    expect(outcome.replay).toBe(false);
  });
});

describe('deduping inside the pipeline', () => {
  it('collapses two copies of a row', () => {
    const outcome = unwrap(runPipeline(envelope(), [row(), row()], options()));
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.duplicates).toBe(1);
  });

  it('passes a bad tolerance back as a failure', () => {
    const r = runPipeline(envelope(), [row(), row()], options({ toleranceMillis: -1 }));
    expect(isErr(r)).toBe(true);
  });
});

describe('summarize', () => {
  it('gives the numbers the ingest log prints', () => {
    const outcome = unwrap(
      runPipeline(envelope(), [row(), row({ channel: 'billboard' })], options()),
    );
    expect(summarize(outcome)).toEqual({
      source: 'fuel-desk',
      sequence: 118,
      rowsIn: 2,
      accepted: 1,
      duplicates: 0,
      quarantined: 1,
      replay: false,
    });
  });
});

describe('problemsOf', () => {
  it('is empty for a success', () => {
    expect(
      problemsOf(
        unwrap(runPipeline(envelope({ declaredRows: 0 }), [], options())) && { ok: true, value: 1 },
      ),
    ).toEqual([]);
  });

  it('gives the problems of a failure', () => {
    expect(problemsOf(runPipeline(envelope({ declaredRows: 9 }), [], options()))).toHaveLength(1);
  });
});
