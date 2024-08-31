import { describe, expect, it } from 'vitest';
import { advocateId, carrierId, touchId } from '../../src/domain/identity.js';
import {
  TOUCH_CHANNELS,
  channelStrength,
  describeTouch,
  isSelfTouch,
  isTouchChannel,
  parseTouchChannel,
  touchNaturalKey,
  touchOrder,
  validateTouch,
  type ReferralTouch,
} from '../../src/domain/touch.js';
import { sorted } from '../../src/util/ordering.js';
import { isErr, unwrap } from '../../src/util/result.js';

const touch: ReferralTouch = {
  id: touchId(1),
  advocate: advocateId(1),
  invitee: carrierId(9),
  channel: 'card',
  presentedCode: 'AB3K9ZQ',
  at: Date.UTC(2025, 1, 3, 14, 0, 0),
  sourceReference: 'fuel-desk-2025-02-03.csv:41',
  inviteeInferred: false,
};

describe('channels', () => {
  it('names four channels', () => {
    expect(TOUCH_CHANNELS).toHaveLength(4);
  });

  it('recognises and rejects channel names', () => {
    expect(isTouchChannel('packet')).toBe(true);
    expect(isTouchChannel('billboard')).toBe(false);
  });

  it('parses case insensitively', () => {
    expect(unwrap(parseTouchChannel(' Packet '))).toBe('packet');
  });

  it('rejects an unknown channel', () => {
    const r = parseTouchChannel('billboard');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('touch_channel_unknown');
    }
  });

  it('ranks a signed packet field above a recruiter note', () => {
    expect(channelStrength('packet')).toBeGreaterThan(channelStrength('verbal'));
    expect(channelStrength('card')).toBeGreaterThan(channelStrength('link'));
  });

  it('gives every channel a distinct strength', () => {
    const strengths = TOUCH_CHANNELS.map(channelStrength);
    expect(new Set(strengths).size).toBe(strengths.length);
  });
});

describe('touchOrder', () => {
  it('puts the earlier instant first', () => {
    const earlier: ReferralTouch = { ...touch, id: touchId(2), at: touch.at - 1000 };
    expect(sorted([touch, earlier], touchOrder)[0]!.id).toBe(earlier.id);
  });

  it('breaks a tie on the instant with channel strength', () => {
    const weaker: ReferralTouch = { ...touch, id: touchId(2), channel: 'verbal' };
    expect(sorted([touch, weaker], touchOrder)[1]!.channel).toBe('card');
  });

  it('breaks a tie on instant and channel with the identifier', () => {
    const other: ReferralTouch = { ...touch, id: touchId(2) };
    const ordered = sorted([other, touch], touchOrder);
    expect(ordered[0]!.id).toBe(touch.id);
  });

  it('does not depend on the input order', () => {
    const b: ReferralTouch = { ...touch, id: touchId(2), channel: 'link' };
    const c: ReferralTouch = { ...touch, id: touchId(3), channel: 'packet' };
    const one = sorted([touch, b, c], touchOrder).map((t) => t.id);
    const two = sorted([c, touch, b], touchOrder).map((t) => t.id);
    expect(one).toEqual(two);
  });
});

describe('touchNaturalKey', () => {
  it('ignores the surrogate identifier', () => {
    expect(touchNaturalKey({ ...touch, id: touchId(77) })).toBe(touchNaturalKey(touch));
  });

  it('ignores the source reference', () => {
    expect(touchNaturalKey({ ...touch, sourceReference: 'other.csv:1' })).toBe(
      touchNaturalKey(touch),
    );
  });

  it('separates two channels', () => {
    expect(touchNaturalKey({ ...touch, channel: 'link' })).not.toBe(touchNaturalKey(touch));
  });

  it('separates two instants', () => {
    expect(touchNaturalKey({ ...touch, at: touch.at + 1 })).not.toBe(touchNaturalKey(touch));
  });

  it('separates two invitees', () => {
    expect(touchNaturalKey({ ...touch, invitee: carrierId(10) })).not.toBe(touchNaturalKey(touch));
  });
});

describe('isSelfTouch', () => {
  it('sees a carrier presenting their own code', () => {
    expect(isSelfTouch(touch, carrierId(9))).toBe(true);
    expect(isSelfTouch(touch, carrierId(8))).toBe(false);
  });
});

describe('validateTouch', () => {
  it('accepts a complete touch', () => {
    expect(unwrap(validateTouch(touch))).toEqual(touch);
  });

  it('rejects a blank code', () => {
    expect(isErr(validateTouch({ ...touch, presentedCode: '  ' }))).toBe(true);
  });

  it('rejects a missing instant', () => {
    const r = validateTouch({ ...touch, at: Number.NaN });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('touch_instant_missing');
    }
  });

  it('rejects a touch with no feed row behind it', () => {
    expect(isErr(validateTouch({ ...touch, sourceReference: '' }))).toBe(true);
  });
});

describe('describeTouch', () => {
  it('says when the invitee was inferred', () => {
    expect(describeTouch(touch)).not.toContain('inferred');
    expect(describeTouch({ ...touch, inviteeInferred: true })).toContain('invitee inferred');
  });
});
