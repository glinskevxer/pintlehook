import { describe, expect, it } from 'vitest';
import {
  attributionWindow,
  creditedAdvocate,
  describeAttribution,
  resolveAttribution,
  touchDay,
  type AttributionInput,
} from '../../src/domain/attribution.js';
import { advocateId, carrierId, touchId } from '../../src/domain/identity.js';
import type { ScreenVerdict } from '../../src/domain/screen.js';
import type { ReferralTouch } from '../../src/domain/touch.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const activation = day(2025, 4, 10);
const clear: ScreenVerdict = { screened: false, signals: [], score: 0 };
const dirty: ScreenVerdict = { screened: true, signals: ['same_authority'], score: 100 };

function touchOn(
  sequence: number,
  advocate: number,
  at: string,
  channel: 'card' | 'link' = 'card',
): ReferralTouch {
  return {
    id: touchId(sequence),
    advocate: advocateId(advocate),
    invitee: carrierId(9),
    channel,
    presentedCode: 'AB3K9ZQ',
    at: Date.parse(at),
    sourceReference: `feed:${sequence}`,
    inviteeInferred: false,
  };
}

function run(touches: ReferralTouch[], screen: AttributionInput['screen'] = () => clear) {
  return unwrap(
    resolveAttribution({
      touches,
      effectiveActivation: activation,
      attributionWindowDays: 90,
      zone: 'America/Chicago',
      screen,
    }),
  );
}

describe('attributionWindow', () => {
  it('ends on the activation day and includes it', () => {
    const window = unwrap(attributionWindow(activation, 90));
    expect(window.until).toEqual(day(2025, 4, 11));
    expect(window.from).toEqual(day(2025, 1, 11));
  });

  it('refuses a window of no days', () => {
    const r = attributionWindow(activation, 0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('attribution_window_length');
    }
  });
});

describe('touchDay', () => {
  it('reads the terminal local day, not the UTC day', () => {
    const late = touchOn(1, 1, '2025-04-11T02:30:00Z');
    expect(touchDay(late, 'America/Chicago')).toEqual(day(2025, 4, 10));
    expect(touchDay(late, 'UTC')).toEqual(day(2025, 4, 11));
  });
});

describe('resolveAttribution', () => {
  it('credits the latest surviving touch', () => {
    const outcome = run([
      touchOn(1, 1, '2025-02-01T15:00:00Z'),
      touchOn(2, 2, '2025-03-15T15:00:00Z'),
      touchOn(3, 3, '2025-01-20T15:00:00Z'),
    ]);
    expect(outcome.credited).toBe(true);
    expect(creditedAdvocate(outcome)).toBe(advocateId(2));
  });

  it('includes a touch on the activation day itself', () => {
    const outcome = run([touchOn(1, 1, '2025-04-10T15:00:00Z')]);
    expect(outcome.credited).toBe(true);
  });

  it('excludes a touch the day after activation', () => {
    const outcome = run([touchOn(1, 1, '2025-04-11T15:00:00Z')]);
    expect(outcome.credited).toBe(false);
    if (!outcome.credited) {
      expect(outcome.reason).toBe('all_outside_window');
    }
    expect(outcome.outsideWindow).toHaveLength(1);
  });

  it('includes the first day of the window and excludes the day before', () => {
    expect(run([touchOn(1, 1, '2025-01-11T15:00:00Z')]).credited).toBe(true);
    expect(run([touchOn(1, 1, '2025-01-10T15:00:00Z')]).credited).toBe(false);
  });

  it('reports no touches at all separately from all outside', () => {
    const outcome = run([]);
    expect(outcome.credited).toBe(false);
    if (!outcome.credited) {
      expect(outcome.reason).toBe('no_touches');
    }
  });

  it('promotes the touch underneath a screened winner', () => {
    const winner = touchOn(1, 1, '2025-03-15T15:00:00Z');
    const runnerUp = touchOn(2, 2, '2025-03-01T15:00:00Z');
    const outcome = run([winner, runnerUp], (t) => (t.id === winner.id ? dirty : clear));
    expect(creditedAdvocate(outcome)).toBe(advocateId(2));
    expect(outcome.screened).toHaveLength(1);
  });

  it('leaves the referral uncredited when every touch is screened', () => {
    const outcome = run([touchOn(1, 1, '2025-03-15T15:00:00Z')], () => dirty);
    expect(outcome.credited).toBe(false);
    if (!outcome.credited) {
      expect(outcome.reason).toBe('all_screened');
    }
  });

  it('does not screen a touch outside the window', () => {
    const outcome = run(
      [touchOn(1, 1, '2025-01-01T15:00:00Z'), touchOn(2, 2, '2025-03-01T15:00:00Z')],
      () => dirty,
    );
    expect(outcome.screened).toHaveLength(1);
    expect(outcome.outsideWindow).toHaveLength(1);
  });

  it('treats an unreadable screen as clearing the touch', () => {
    const outcome = run([touchOn(1, 1, '2025-03-15T15:00:00Z')], () => undefined);
    expect(outcome.credited).toBe(true);
  });

  it('breaks a tie on the instant with channel strength', () => {
    const weak = touchOn(1, 1, '2025-03-15T15:00:00Z', 'link');
    const strong = touchOn(2, 2, '2025-03-15T15:00:00Z', 'card');
    expect(creditedAdvocate(run([strong, weak]))).toBe(advocateId(2));
    expect(creditedAdvocate(run([weak, strong]))).toBe(advocateId(2));
  });

  it('moves the credit when the window narrows', () => {
    const touches = [touchOn(1, 1, '2025-01-20T15:00:00Z'), touchOn(2, 2, '2025-03-15T15:00:00Z')];
    const wide = unwrap(
      resolveAttribution({
        touches,
        effectiveActivation: activation,
        attributionWindowDays: 90,
        zone: 'America/Chicago',
        screen: (t) => (t.advocate === advocateId(2) ? dirty : clear),
      }),
    );
    const narrow = unwrap(
      resolveAttribution({
        touches,
        effectiveActivation: activation,
        attributionWindowDays: 30,
        zone: 'America/Chicago',
        screen: (t) => (t.advocate === advocateId(2) ? dirty : clear),
      }),
    );
    expect(creditedAdvocate(wide)).toBe(advocateId(1));
    expect(creditedAdvocate(narrow)).toBeUndefined();
  });

  it('passes the window failure through', () => {
    const r = resolveAttribution({
      touches: [],
      effectiveActivation: activation,
      attributionWindowDays: -1,
      zone: 'UTC',
      screen: () => clear,
    });
    expect(isErr(r)).toBe(true);
  });
});

describe('describeAttribution', () => {
  it('names the channel that won', () => {
    expect(describeAttribution(run([touchOn(1, 1, '2025-03-01T15:00:00Z')]))).toContain(
      'card touch',
    );
  });

  it('names the reason when nothing was credited', () => {
    expect(describeAttribution(run([]))).toBe('uncredited: no_touches');
  });
});
