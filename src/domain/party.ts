/**
 * A party is a motor carrier the brokerage has a file on. Advocates and invited
 * carriers are both parties, which matters because the common authority screen
 * has to compare one against the other on fields that only exist here.
 */

import type { Day } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { fail, ok, type Result } from '../util/result.js';
import type { CarrierId } from './identity.js';

export type AuthorityStatus = 'active' | 'pending' | 'revoked' | 'unknown';

export interface RemitAddress {
  readonly line1: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

export interface BankAccount {
  /** Routing and account are held as a digest, never in the clear. */
  readonly routingDigest: string;
  readonly accountDigest: string;
}

export interface Party {
  readonly id: CarrierId;
  readonly legalName: string;
  readonly motorCarrierNumber: string;
  readonly dotNumber: string;
  readonly authorityStatus: AuthorityStatus;
  readonly authoritySince?: Day;
  readonly remit: RemitAddress;
  readonly bank?: BankAccount;
  readonly powerUnits: number;
}

const STATE_PATTERN = /^[A-Z]{2}$/;
const POSTAL_PATTERN = /^\d{5}(?:-\d{4})?$/;

export function normalizeLegalName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(LLC|L L C|INC|INCORPORATED|CO|COMPANY|CORP|CORPORATION|LTD)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePostalCode(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 5 ? trimmed.slice(0, 5) : trimmed;
}

export function validateRemitAddress(address: RemitAddress): Result<RemitAddress> {
  if (address.line1.trim() === '') {
    return fail('remit_line1_missing', 'a remit address needs a street line');
  }
  if (!STATE_PATTERN.test(address.state)) {
    return fail('remit_state_shape', `"${address.state}" is not a two letter state code`);
  }
  if (!POSTAL_PATTERN.test(address.postalCode)) {
    return fail('remit_postal_shape', `"${address.postalCode}" is not a postal code`);
  }
  return ok(address);
}

/** A digest that collapses the spellings of one physical remit address. */
export function remitDigest(address: RemitAddress): string {
  return digestOfParts([
    address.line1.toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim(),
    address.city.toUpperCase().trim(),
    address.state.toUpperCase().trim(),
    normalizePostalCode(address.postalCode),
  ]);
}

export function bankDigest(account: BankAccount): string {
  return digestOfParts([account.routingDigest, account.accountDigest]);
}

export function hasOperatingAuthority(party: Party): boolean {
  return party.authorityStatus === 'active';
}

export function isSingleTruck(party: Party): boolean {
  return party.powerUnits <= 1;
}

export function isFleet(party: Party): boolean {
  return party.powerUnits >= 5;
}

export function describeParty(party: Party): string {
  return `${party.legalName} (${party.motorCarrierNumber}, DOT ${party.dotNumber})`;
}

export function validateParty(party: Party): Result<Party> {
  if (party.legalName.trim() === '') {
    return fail('party_name_missing', 'a party needs a legal name');
  }
  if (!Number.isInteger(party.powerUnits) || party.powerUnits < 0) {
    return fail('party_power_units', `power units must be a whole number, got ${party.powerUnits}`);
  }
  const address = validateRemitAddress(party.remit);
  if (!address.ok) {
    return address;
  }
  return ok(party);
}
