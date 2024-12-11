/**
 * Clock normalisation. A fuel desk terminal stamps in its own local time off
 * its own clock, and both are wrong in ways we can correct.
 *
 * The zone is corrected from the envelope. The drift is corrected from the
 * terminal's own heartbeat: the difference between what it thought the time was
 * and what the receiver's clock read, interpolated between the heartbeats
 * either side of the reading.
 *
 * This matters more than it sounds. A touch three seconds before midnight local
 * on a terminal running four minutes fast is really on the previous day, and
 * the previous day may be outside the attribution window.
 */

import { type Instant } from '../util/clock.js';
import { ascending, byKey, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import { localDayOf, type ZoneId } from '../util/zoned.js';

export interface ClockHeartbeat {
  /** What the terminal said the time was. */
  readonly terminalAt: Instant;
  /** What our receiver's clock said when the heartbeat landed. */
  readonly receivedAt: Instant;
}

export interface TerminalClock {
  readonly terminal: string;
  readonly zone: ZoneId;
  readonly heartbeats: readonly ClockHeartbeat[];
}

export interface Normalized {
  readonly at: Instant;
  readonly driftMillis: number;
  readonly interpolated: boolean;
}

export const MAX_PLAUSIBLE_DRIFT_MILLIS = 6 * 60 * 60 * 1000;

function driftOf(heartbeat: ClockHeartbeat): number {
  return heartbeat.terminalAt - heartbeat.receivedAt;
}

export function orderedHeartbeats(clock: TerminalClock): ClockHeartbeat[] {
  return sorted(
    clock.heartbeats,
    byKey((beat: ClockHeartbeat) => beat.terminalAt, ascending),
  );
}

export function validateClock(clock: TerminalClock): Result<TerminalClock> {
  if (clock.heartbeats.length === 0) {
    return fail('clock_no_heartbeats', `terminal ${clock.terminal} has no heartbeats`);
  }
  for (const beat of clock.heartbeats) {
    if (Math.abs(driftOf(beat)) > MAX_PLAUSIBLE_DRIFT_MILLIS) {
      return fail(
        'clock_drift_implausible',
        `terminal ${clock.terminal} reports a drift of ${driftOf(beat)} milliseconds`,
      );
    }
  }
  return ok(clock);
}

/**
 * Drift at a reading. Between two heartbeats it is interpolated linearly.
 * Before the first or after the last it is held flat, because extrapolating a
 * clock that has stopped reporting invents a correction nobody measured.
 */
export function driftAt(clock: TerminalClock, terminalAt: Instant): Result<Normalized> {
  const beats = orderedHeartbeats(clock);
  const first = beats[0];
  if (first === undefined) {
    return fail('clock_no_heartbeats', `terminal ${clock.terminal} has no heartbeats`);
  }
  const last = beats[beats.length - 1] as ClockHeartbeat;
  if (terminalAt <= first.terminalAt) {
    return ok({
      at: terminalAt - driftOf(first),
      driftMillis: driftOf(first),
      interpolated: false,
    });
  }
  if (terminalAt >= last.terminalAt) {
    return ok({ at: terminalAt - driftOf(last), driftMillis: driftOf(last), interpolated: false });
  }
  for (let i = 1; i < beats.length; i += 1) {
    const before = beats[i - 1] as ClockHeartbeat;
    const after = beats[i] as ClockHeartbeat;
    if (terminalAt >= before.terminalAt && terminalAt <= after.terminalAt) {
      const span = after.terminalAt - before.terminalAt;
      const position = terminalAt - before.terminalAt;
      const spread = driftOf(after) - driftOf(before);
      const drift =
        span === 0 ? driftOf(before) : Math.round(driftOf(before) + (spread * position) / span);
      return ok({ at: terminalAt - drift, driftMillis: drift, interpolated: true });
    }
  }
  return fail('clock_no_bracket', 'no pair of heartbeats brackets the reading');
}

export function normalize(clock: TerminalClock, terminalAt: Instant): Result<Normalized> {
  const checked = validateClock(clock);
  return checked.ok ? driftAt(clock, terminalAt) : checked;
}

/** The terminal local day a reading falls on once the drift is taken out. */
export function normalizedLocalDay(clock: TerminalClock, terminalAt: Instant) {
  const normalized = normalize(clock, terminalAt);
  return normalized.ok ? ok(localDayOf(clock.zone, normalized.value.at)) : normalized;
}

export function perfectClock(terminal: string, zone: ZoneId, at: Instant): TerminalClock {
  return { terminal, zone, heartbeats: [{ terminalAt: at, receivedAt: at }] };
}
