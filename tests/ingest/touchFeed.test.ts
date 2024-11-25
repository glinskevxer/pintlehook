import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/ingest/envelope.js';
import {
  TOUCH_COLUMNS,
  hasInviteeHandle,
  readTouchFeed,
  readTouchRow,
  withoutInviteeHandle,
} from '../../src/ingest/touchFeed.js';
import { mintReferralCode } from '../../src/util/ids.js';
import { isErr, unwrap } from '../../src/util/result.js';

const envelope = unwrap(
  readEnvelope({
    source: 'fuel-desk',
    kind: 'touch',
    cutAt: '2025-04-01T06:00:00Z',
    declaredRows: 1,
    zone: 'America/Chicago',
    sequence: 118,
  }),
);

const code = unwrap(mintReferralCode('AB3K9Z'));

function row(overrides: Record<string, string> = {}) {
  return {
    referral_code: code,
    channel: 'card',
    occurred_at: '2025-03-15T15:04:00Z',
    invitee_mc: 'MC884210',
    invitee_dot: '',
    invitee_name: '',
    ...overrides,
  };
}

describe('columns', () => {
  it('names the three that have to be there', () => {
    expect(TOUCH_COLUMNS).toEqual(['referral_code', 'channel', 'occurred_at']);
  });
});

describe('readTouchRow', () => {
  it('reads a good row', () => {
    const draft = unwrap(readTouchRow(envelope, row(), 1));
    expect(draft.presentedCode).toBe(code);
    expect(draft.channel).toBe('card');
    expect(draft.at).toBe(Date.UTC(2025, 2, 15, 15, 4, 0));
    expect(draft.inviteeMotorCarrierNumber).toBe('MC884210');
    expect(draft.inviteeDotNumber).toBeUndefined();
  });

  it('stamps the row it came from', () => {
    expect(unwrap(readTouchRow(envelope, row(), 41)).sourceReference).toBe(
      'fuel-desk/touch/118:41',
    );
  });

  it('accepts a code typed with a separator', () => {
    const separated = `${code.slice(0, 3)}-${code.slice(3)}`;
    expect(unwrap(readTouchRow(envelope, row({ referral_code: separated }), 1)).presentedCode).toBe(
      code,
    );
  });

  it('rejects a code that fails its check character', () => {
    const broken = `${code.slice(0, 2)}8${code.slice(3)}`;
    const r = readTouchRow(envelope, row({ referral_code: broken }), 1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('referral_code');
      expect(r.problems[0]!.code).toBe('referral_code_check');
    }
  });

  it('rejects a channel it does not know', () => {
    expect(isErr(readTouchRow(envelope, row({ channel: 'billboard' }), 1))).toBe(true);
  });

  it('folds a channel written with a capital', () => {
    expect(unwrap(readTouchRow(envelope, row({ channel: 'Packet' }), 1)).channel).toBe('packet');
  });

  it('rejects an instant with no zone', () => {
    expect(isErr(readTouchRow(envelope, row({ occurred_at: '2025-03-15 15:04:00' }), 1))).toBe(
      true,
    );
  });

  it('gathers every problem in one pass rather than stopping at the first', () => {
    const r = readTouchRow(
      envelope,
      row({ channel: 'billboard', occurred_at: 'yesterday', referral_code: '' }),
      1,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems.length).toBeGreaterThan(1);
    }
  });
});

describe('readTouchFeed', () => {
  it('keeps the good rows and sets the bad ones aside', () => {
    const read = readTouchFeed(envelope, [row(), row({ channel: 'billboard' }), row()]);
    expect(read.accepted).toHaveLength(2);
    expect(read.rejected).toHaveLength(1);
    expect(read.rejected[0]!.rowNumber).toBe(2);
  });

  it('keeps the original row on a rejection so it can be looked at', () => {
    const read = readTouchFeed(envelope, [row({ channel: 'billboard' })]);
    expect(read.rejected[0]!.row['channel']).toBe('billboard');
  });

  it('numbers rows from one', () => {
    const read = readTouchFeed(envelope, [row({ channel: 'billboard' })]);
    expect(read.rejected[0]!.rowNumber).toBe(1);
  });

  it('reads an empty file', () => {
    const read = readTouchFeed(envelope, []);
    expect(read.accepted).toEqual([]);
    expect(read.rejected).toEqual([]);
  });
});

describe('invitee handles', () => {
  it('sees a motor carrier number', () => {
    expect(hasInviteeHandle(unwrap(readTouchRow(envelope, row(), 1)))).toBe(true);
  });

  it('sees a dot number on its own', () => {
    const draft = unwrap(
      readTouchRow(envelope, row({ invitee_mc: '', invitee_dot: '3126540' }), 1),
    );
    expect(hasInviteeHandle(draft)).toBe(true);
  });

  it('sees a name on its own', () => {
    const draft = unwrap(
      readTouchRow(envelope, row({ invitee_mc: '', invitee_name: 'Brannan Hauling' }), 1),
    );
    expect(hasInviteeHandle(draft)).toBe(true);
  });

  it('sees when there is nothing to go on', () => {
    const draft = unwrap(readTouchRow(envelope, row({ invitee_mc: 'n/a' }), 1));
    expect(hasInviteeHandle(draft)).toBe(false);
  });

  it('lists the drafts that cannot be resolved', () => {
    const read = readTouchFeed(envelope, [row(), row({ invitee_mc: '' })]);
    expect(withoutInviteeHandle(read)).toHaveLength(1);
  });
});
