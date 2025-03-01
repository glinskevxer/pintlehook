/**
 * Turning whatever handle a feed gave us into a carrier we have a file on.
 *
 * The order matters and it is not arbitrary. A motor carrier number is issued
 * by the regulator and cannot be typed two ways once normalised, so it wins. A
 * USDOT number is nearly as good but several carriers share one when an
 * authority is leased. A trading name is a last resort and it only resolves
 * when exactly one file matches, because two outfits called Delta Transport is
 * not a hypothetical.
 */

import { normalizeLegalName } from '../domain/party.js';
import { parseDotNumber, parseMotorCarrierNumber } from '../util/ids.js';
import { fail, ok, type Result } from '../util/result.js';
import type { CarrierRow } from '../storage/rows.js';
import type { Store } from '../storage/store.js';

export type ResolutionBasis = 'motor_carrier_number' | 'dot_number' | 'legal_name';

export interface ResolutionInput {
  readonly motorCarrierNumber?: string | undefined;
  readonly dotNumber?: string | undefined;
  readonly legalName?: string | undefined;
}

export interface Resolved {
  readonly carrier: CarrierRow;
  readonly basis: ResolutionBasis;
}

export function resolveCarrier(store: Store, input: ResolutionInput): Result<Resolved> {
  if (input.motorCarrierNumber !== undefined) {
    const parsed = parseMotorCarrierNumber(input.motorCarrierNumber);
    if (parsed.ok) {
      const row = store.carriers.oneBy('mc', parsed.value);
      if (!row.ok) {
        return row;
      }
      if (row.value !== undefined) {
        return ok({ carrier: row.value, basis: 'motor_carrier_number' });
      }
    }
  }
  if (input.dotNumber !== undefined) {
    const parsed = parseDotNumber(input.dotNumber);
    if (parsed.ok) {
      const rows = store.carriers.by('dot', parsed.value);
      if (!rows.ok) {
        return rows;
      }
      if (rows.value.length === 1) {
        return ok({ carrier: rows.value[0] as CarrierRow, basis: 'dot_number' });
      }
      if (rows.value.length > 1) {
        return fail(
          'resolution_dot_ambiguous',
          `${rows.value.length} carriers share USDOT ${parsed.value}`,
        );
      }
    }
  }
  if (input.legalName !== undefined) {
    const wanted = normalizeLegalName(input.legalName);
    if (wanted !== '') {
      const matches = store.carriers.where((row) => normalizeLegalName(row.legalName) === wanted);
      if (matches.length === 1) {
        return ok({ carrier: matches[0] as CarrierRow, basis: 'legal_name' });
      }
      if (matches.length > 1) {
        return fail(
          'resolution_name_ambiguous',
          `${matches.length} carriers trade as "${input.legalName}"`,
        );
      }
    }
  }
  return fail('resolution_no_match', 'nothing on this row matches a carrier we have a file on');
}

export function basisStrength(basis: ResolutionBasis): number {
  switch (basis) {
    case 'motor_carrier_number':
      return 3;
    case 'dot_number':
      return 2;
    case 'legal_name':
      return 1;
  }
}

export function isInferred(basis: ResolutionBasis): boolean {
  return basis === 'legal_name';
}

export function describeResolution(resolved: Resolved): string {
  return `${resolved.carrier.id} on ${resolved.basis}`;
}
