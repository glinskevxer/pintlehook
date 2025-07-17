/**
 * Referral routes. Reading the state of a referral, and the one write worth
 * having over an api: recording a touch.
 *
 * The touch route takes the same draft shape the feed adapter produces, so a
 * partner integrating directly and a partner shipping a file end up in exactly
 * the same code, screens included.
 */

import { parseInstant } from '../util/clock.js';
import { err, fail, ok, type Result } from '../util/result.js';
import {
  readCarrierId,
  readProgramId,
  type CarrierId,
  type ProgramId,
} from '../domain/identity.js';
import { parseTouchChannel } from '../domain/touch.js';
import type { TouchDraft } from '../ingest/touchFeed.js';
import { recordTouch } from '../service/referrals.js';
import { referralByKey, referralsInState, touchesForInvitee } from '../storage/repositories.js';
import { NO_DAY } from '../storage/rows.js';
import { optionalQuery, requiredQuery, type ApiRequest, type Route } from './router.js';

function text(body: Readonly<Record<string, unknown>>, field: string): Result<string> {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== ''
    ? ok(value.trim())
    : fail('body_field_missing', `${field} is required`, field);
}

function optionalText(body: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function draftFrom(request: ApiRequest): Result<TouchDraft> {
  const code = text(request.body, 'referralCode');
  const channel = text(request.body, 'channel');
  const at = text(request.body, 'occurredAt');
  if (!code.ok || !channel.ok || !at.ok) {
    return err([
      ...(code.ok ? [] : code.problems),
      ...(channel.ok ? [] : channel.problems),
      ...(at.ok ? [] : at.problems),
    ]);
  }
  const parsedChannel = parseTouchChannel(channel.value);
  if (!parsedChannel.ok) {
    return parsedChannel;
  }
  const parsedAt = parseInstant(at.value);
  if (!parsedAt.ok) {
    return parsedAt;
  }
  return ok({
    presentedCode: code.value,
    channel: parsedChannel.value,
    at: parsedAt.value,
    inviteeMotorCarrierNumber: optionalText(request.body, 'inviteeMotorCarrierNumber'),
    inviteeDotNumber: optionalText(request.body, 'inviteeDotNumber'),
    inviteeName: optionalText(request.body, 'inviteeName'),
    sourceReference: optionalText(request.body, 'sourceReference') ?? `api/${request.actor}`,
    rowNumber: 1,
  });
}

export const postTouch: Route = {
  method: 'post',
  path: '/touches',
  summary: 'record one referral touch through the same rules a feed row takes',
  handle: (context, _catalog, request) => {
    const draft = draftFrom(request);
    if (!draft.ok) {
      return draft;
    }
    const recorded = recordTouch(context, draft.value);
    if (!recorded.ok) {
      return recorded;
    }
    const written = context.store.commit(recorded.value.drafts);
    if (!written.ok) {
      return written;
    }
    return ok({
      touch: recorded.value.touch,
      advocate: recorded.value.advocate,
      invitee: recorded.value.invitee,
      openedReferral: recorded.value.openedReferral,
      inviteeInferred: recorded.value.inviteeInferred,
    });
  },
};

export const getReferral: Route = {
  method: 'get',
  path: '/referrals/:program/:invitee',
  summary: 'one referral with the days it carries',
  handle: (context, _catalog, _request, params) => {
    const program = readProgramId(params['program'] ?? '');
    if (!program.ok) {
      return program;
    }
    const invitee = readCarrierId(params['invitee'] ?? '');
    if (!invitee.ok) {
      return invitee;
    }
    const row = referralByKey(context.store, program.value, invitee.value);
    if (!row.ok) {
      return row;
    }
    return ok({
      key: row.value.key,
      state: row.value.state,
      advocate: row.value.advocate === '' ? null : row.value.advocate,
      recordedOn: row.value.recordedOn,
      effectiveActivation:
        row.value.effectiveActivation === NO_DAY ? null : row.value.effectiveActivation,
      qualifiedOn: row.value.qualifiedOn === NO_DAY ? null : row.value.qualifiedOn,
      reversedOn: row.value.reversedOn === NO_DAY ? null : row.value.reversedOn,
    });
  },
};

export const listReferrals: Route = {
  method: 'get',
  path: '/referrals',
  summary: 'referrals in a state, which the query has to name',
  handle: (context, _catalog, request) => {
    const state = requiredQuery(request, 'state');
    if (!state.ok) {
      return state;
    }
    const program = optionalQuery(request, 'program');
    const rows = referralsInState(context.store, state.value).filter(
      (row) => program === undefined || row.program === program,
    );
    return ok(
      rows.map((row) => ({
        key: row.key,
        advocate: row.advocate === '' ? null : row.advocate,
        invitee: row.invitee,
        state: row.state,
      })),
    );
  },
};

export const listTouches: Route = {
  method: 'get',
  path: '/carriers/:invitee/touches',
  summary: 'every touch on file for an invited carrier',
  handle: (context, _catalog, _request, params) => {
    const invitee = readCarrierId(params['invitee'] ?? '');
    if (!invitee.ok) {
      return invitee;
    }
    return ok(
      touchesForInvitee(context.store, invitee.value).map((row) => ({
        touch: row.id,
        advocate: row.advocate,
        channel: row.channel,
        at: row.at,
        sourceReference: row.sourceReference,
      })),
    );
  },
};

export const referralRoutes: readonly Route[] = [
  postTouch,
  getReferral,
  listReferrals,
  listTouches,
];

export function inviteeOf(params: Readonly<Record<string, string>>): Result<CarrierId> {
  return readCarrierId(params['invitee'] ?? '');
}

export function programOf(params: Readonly<Record<string, string>>): Result<ProgramId> {
  return readProgramId(params['program'] ?? '');
}
